pub mod error;
pub use error::{CsvError, Result};

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use arrow_csv::{reader::Format, ReaderBuilder};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use sysinfo::System;

const LOW_MEMORY_BATCH_ROWS: usize = 1_024;
const LOW_MEMORY_ROW_GROUP_ROWS: usize = 8_192;
const BALANCED_BATCH_ROWS: usize = 4_096;
const BALANCED_ROW_GROUP_ROWS: usize = 32_768;
const FAST_BATCH_ROWS: usize = 8_192;
const FAST_ROW_GROUP_ROWS: usize = 65_536;
const DEFAULT_SCHEMA_SAMPLE_ROWS: usize = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConvertProfile {
    Auto,
    LowMemory,
    Balanced,
    Fast,
}

impl ConvertProfile {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "low_memory" => Ok(Self::LowMemory),
            "balanced" => Ok(Self::Balanced),
            "fast" => Ok(Self::Fast),
            _ => Err(CsvError::Other(format!(
                "Unsupported CSV conversion profile: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConvertOptions {
    pub delimiter: u8,
    pub has_header: bool,
    pub all_varchar: bool,
    pub schema_sample_rows: usize,
    pub batch_rows: usize,
    pub row_group_rows: usize,
    pub compression: Compression,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            delimiter: b',',
            has_header: true,
            all_varchar: true,
            schema_sample_rows: DEFAULT_SCHEMA_SAMPLE_ROWS,
            batch_rows: BALANCED_BATCH_ROWS,
            row_group_rows: BALANCED_ROW_GROUP_ROWS,
            compression: Compression::ZSTD(Default::default()),
        }
    }
}

pub fn options_for_profile(profile: ConvertProfile) -> ConvertOptions {
    match profile {
        ConvertProfile::LowMemory => ConvertOptions {
            batch_rows: LOW_MEMORY_BATCH_ROWS,
            row_group_rows: LOW_MEMORY_ROW_GROUP_ROWS,
            compression: Compression::ZSTD(Default::default()),
            ..Default::default()
        },
        ConvertProfile::Balanced => ConvertOptions::default(),
        ConvertProfile::Fast => ConvertOptions {
            batch_rows: FAST_BATCH_ROWS,
            row_group_rows: FAST_ROW_GROUP_ROWS,
            compression: Compression::SNAPPY,
            ..Default::default()
        },
        ConvertProfile::Auto => auto_convert_options(),
    }
}

fn auto_convert_options() -> ConvertOptions {
    const GIB: u64 = 1024 * 1024 * 1024;

    let mut system = System::new();
    system.refresh_memory();

    let available_memory = system.available_memory();
    let logical_cores = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);

    let mut options = match available_memory {
        available if available < 8 * GIB => options_for_profile(ConvertProfile::LowMemory),
        available if available < 24 * GIB => options_for_profile(ConvertProfile::Balanced),
        _ => ConvertOptions {
            batch_rows: FAST_BATCH_ROWS,
            row_group_rows: FAST_ROW_GROUP_ROWS,
            compression: Compression::ZSTD(Default::default()),
            ..Default::default()
        },
    };

    // The converter currently processes one CSV stream serially. On a small CPU,
    // stay conservative even when the machine has plenty of free memory.
    if logical_cores <= 2 {
        options.batch_rows = LOW_MEMORY_BATCH_ROWS;
        options.row_group_rows = LOW_MEMORY_ROW_GROUP_ROWS;
    }

    eprintln!(
        "[duckview] CSV Auto profile: available_memory={:.1} GiB, logical_cores={}, batch_rows={}, row_group_rows={}",
        available_memory as f64 / GIB as f64,
        logical_cores,
        options.batch_rows,
        options.row_group_rows,
    );

    options
}

fn deduplicate_schema(schema: Schema) -> Schema {
    let mut seen = std::collections::HashMap::<String, usize>::new();
    let mut unnamed_index = 1_usize;
    let mut fields = Vec::with_capacity(schema.fields().len());

    for field in schema.fields() {
        let base_name = if field.name().trim().is_empty() {
            let name = format!("column_{unnamed_index}");
            unnamed_index += 1;
            name
        } else {
            field.name().to_string()
        };

        let count = seen.entry(base_name.clone()).or_insert(0);
        let name = if *count == 0 {
            base_name
        } else {
            format!("{base_name}_{}", *count + 1)
        };
        *count += 1;

        fields.push(Arc::new(
            Field::new(name, field.data_type().clone(), field.is_nullable()),
        ));
    }

    Schema::new_with_metadata(fields, schema.metadata().clone())
}

fn all_varchar_schema(schema: Schema) -> Schema {
    let fields: Vec<_> = schema
        .fields()
        .iter()
        .map(|field| {
            Arc::new(Field::new(
                field.name(),
                DataType::Utf8,
                true,
            ))
        })
        .collect();

    Schema::new_with_metadata(fields, schema.metadata().clone())
}

fn inferred_schema<R: Read>(
    input: R,
    delimiter: u8,
    has_header: bool,
    sample_rows: usize,
) -> Result<Schema> {
    let (schema, _) = Format::default()
        .with_header(has_header)
        .with_delimiter(delimiter)
        .infer_schema(input, Some(sample_rows))
        .map_err(|error| CsvError::SchemaError(error.to_string()))?;

    Ok(schema)
}

pub fn convert_csv_to_parquet(
    input_path: &Path,
    output_path: &Path,
    options: &ConvertOptions,
) -> Result<()> {
    convert_reader_to_parquet(
        || File::open(input_path),
        output_path,
        options,
    )
}

pub fn convert_reader_to_parquet<R, OpenInput>(
    open_input: OpenInput,
    output_path: &Path,
    options: &ConvertOptions,
) -> Result<()>
where
    R: Read,
    OpenInput: Fn() -> std::io::Result<R>,
{
    if options.batch_rows == 0 {
        return Err(CsvError::Other(
            "CSV batch size must be greater than zero.".to_string(),
        ));
    }

    if options.row_group_rows < options.batch_rows {
        return Err(CsvError::Other(
            "Parquet row group size must be at least the CSV batch size."
                .to_string(),
        ));
    }

    let inferred_schema = inferred_schema(
        open_input().map_err(CsvError::FileError)?,
        options.delimiter,
        options.has_header,
        options.schema_sample_rows,
    )?;

    let schema = deduplicate_schema(if options.all_varchar {
        all_varchar_schema(inferred_schema)
    } else {
        inferred_schema
    });
    let schema = Arc::new(schema);

    let input = open_input().map_err(CsvError::FileError)?;
    let mut csv_reader = ReaderBuilder::new(schema.clone())
        .with_header(options.has_header)
        .with_delimiter(options.delimiter)
        .with_batch_size(options.batch_rows)
        .build(input)
        .map_err(|error| CsvError::CsvError(error.to_string()))?;

    let output = File::create(output_path).map_err(CsvError::FileError)?;
    let properties = WriterProperties::builder()
        .set_compression(options.compression)
        .set_max_row_group_row_count(Some(options.row_group_rows))
        .set_created_by("DuckView".to_string())
        .build();

    let mut writer = ArrowWriter::try_new(output, schema, Some(properties))
        .map_err(|error| CsvError::ParquetError(error.to_string()))?;

    for batch in &mut csv_reader {
        let batch = batch.map_err(|error| CsvError::CsvError(error.to_string()))?;

        writer
            .write(&batch)
            .map_err(|error| CsvError::ParquetError(error.to_string()))?;
    }

    writer
        .close()
        .map_err(|error| CsvError::ParquetError(error.to_string()))?;

    Ok(())
}
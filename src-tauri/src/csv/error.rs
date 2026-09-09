use thiserror::Error;

#[derive(Error, Debug)]
pub enum CsvError {
    /// Error that occurs when a file operation fails.
    #[error("File operation failed: {0}")]
    FileError(#[from] std::io::Error),

    /// Error that occurs when CSV parsing fails.
    #[error("CSV parsing error: {0}")]
    CsvError(String),

    /// Error that occurs when Parquet writing fails.
    #[error("Parquet writing error: {0}")]
    ParquetError(String),

    /// Error that occurs when schema inference fails.
    #[error("Schema inference error: {0}")]
    SchemaError(String),

    /// A generic error type for other errors.
    #[error("Other error: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, CsvError>;

impl From<parquet::errors::ParquetError> for CsvError {
    fn from(err: parquet::errors::ParquetError) -> Self {
        CsvError::ParquetError(err.to_string())
    }
}

impl From<Box<dyn std::error::Error>> for CsvError {
    fn from(err: Box<dyn std::error::Error>) -> Self {
        CsvError::Other(err.to_string())
    }
}

use keyring::Entry;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.pnk.duckview";
const KEYRING_ACCOUNT: &str = "ai-api-key";
const MAX_REQUEST_CHARS: usize = 20_000;
const MAX_RESPONSE_CHARS: usize = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettings {
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) authentication: AiAuthentication,
    #[serde(default)]
    pub(crate) proxy_url: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AiAuthentication {
    None,
    Bearer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTableSchema {
    pub(crate) name: String,
    pub(crate) columns: Vec<AiColumnSchema>,
}

#[derive(Deserialize)]
pub(crate) struct AiColumnSchema {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) type_name: String,
}

#[derive(Serialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct ChatCompletionsResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatCompletionsErrorResponse {
    error: Option<ChatCompletionsError>,
}

#[derive(Deserialize)]
struct ChatCompletionsError {
    message: Option<String>,
    code: Option<String>,
}

fn api_key_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("Could not access the system keyring: {error}"))
}

#[tauri::command]
pub(crate) fn ai_key_status() -> Result<bool, String> {
    match api_key_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Could not read the system keyring: {error}")),
    }
}

#[tauri::command]
pub(crate) fn save_ai_api_key(api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();

    if api_key.is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    api_key_entry()?
        .set_password(api_key)
        .map_err(|error| format!("Could not save the API key: {error}"))
}

#[tauri::command]
pub(crate) fn delete_ai_api_key() -> Result<(), String> {
    match api_key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not delete the API key: {error}")),
    }
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/');

    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("AI base URL must start with http:// or https://.".to_string());
    }

    if base_url.is_empty() {
        return Err("AI base URL is required.".to_string());
    }

    if base_url.ends_with("/chat/completions") {
        Ok(base_url.to_string())
    } else {
        Ok(format!("{base_url}/chat/completions"))
    }
}

fn schema_prompt(schema: &[AiTableSchema]) -> String {
    if schema.is_empty() {
        return "No tables are currently open.".to_string();
    }

    schema
        .iter()
        .map(|table| {
            let columns = table
                .columns
                .iter()
                .map(|column| format!("  - {} {}", column.name, column.type_name))
                .collect::<Vec<_>>()
                .join("\n");

            format!("Table: {}\n{}", table.name, columns)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn strip_markdown_code_fence(value: &str) -> String {
    let value = value.trim();

    if !value.starts_with("```") {
        return value.to_string();
    }

    let Some(first_newline) = value.find('\n') else {
        return value.to_string();
    };

    let body = &value[first_newline + 1..];
    body.strip_suffix("```").unwrap_or(body).trim().to_string()
}

fn system_prompt() -> String {
    [
        "You generate one DuckDB SQL query from a user request.",
        "Use only the supplied tables and columns.",
        "Your first output line must be a short ASCII snake_case view name in a SQL line comment, for example: -- monthly_sales_by_region.",
        "Your second output line onward must contain exactly one read-only DuckDB SQL query.",
        "The SQL query must end with a semicolon.",
        "Generate one read-only query starting with SELECT, WITH, VALUES, DESCRIBE, SHOW, PIVOT, or UNPIVOT.",
        "Do not use INSERT, UPDATE, DELETE, CREATE, DROP, COPY, ATTACH, file-reading functions, or extensions.",
        "Return SQL only: no explanation, Markdown, or code fences.",
    ]
        .join(" ")
}

fn generated_view_name_and_sql(value: &str) -> Result<(String, String), String> {
    let value = value.trim();
    let mut lines = value.lines();

    let view_name = lines
        .next()
        .and_then(|line| line.trim().strip_prefix("--"))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or(
            "The AI response must start with a view-name comment, for example: -- monthly_sales.",
        )?;

    if !view_name
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_')
    {
        return Err(
            "The generated view name must use lowercase ASCII letters, digits, and underscores only."
                .to_string(),
        );
    }

    if view_name
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
    {
        return Err("The generated view name must not start with a digit.".to_string());
    }

    let sql = lines.collect::<Vec<_>>().join("\n");

    if sql.trim().is_empty() {
        return Err("The AI response did not include a SQL query.".to_string());
    }

    Ok((view_name.to_string(), sql))
}


#[tauri::command]
pub(crate) async fn generate_sql_from_prompt(
    settings: AiSettings,
    request: String,
    schema: Vec<AiTableSchema>,
) -> Result<String, String> {
    let request = request.trim();

    if request.is_empty() {
        return Err("Enter a request in a SQL comment or select text first.".to_string());
    }

    if request.chars().count() > MAX_REQUEST_CHARS {
        return Err("The AI request is too long.".to_string());
    }

    let model = settings.model.trim();

    if model.is_empty() {
        return Err("AI model is required.".to_string());
    }

    let url = chat_completions_url(&settings.base_url)?;
    let user_prompt = format!(
        "Schema:\n{}\n\nRequest:\n{}",
        schema_prompt(&schema),
        request,
    );

    let request_body = ChatCompletionsRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: system_prompt(),
            },
            ChatMessage {
                role: "user",
                content: user_prompt,
            },
        ],
        stream: false,
    };

    let mut client_builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(90));

    let proxy_url = settings.proxy_url.trim();
    if !proxy_url.is_empty() {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|error| format!("Invalid AI proxy URL: {error}"))?;
        client_builder = client_builder.proxy(proxy);
    }

    let client = client_builder
        .build()
        .map_err(|error| format!("Could not create the AI HTTP client: {error}"))?;

    let mut request_builder = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .json(&request_body);

    if settings.authentication == AiAuthentication::Bearer {
        let api_key = api_key_entry()?
            .get_password()
            .map_err(|_| "No AI API key is saved. Open Settings to save one.".to_string())?;

        request_builder = request_builder.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }

    let response = request_builder
        .send()
        .await
        .map_err(|error| format!("Could not contact the AI service: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        let detail = serde_json::from_str::<ChatCompletionsErrorResponse>(&body)
            .ok()
            .and_then(|response| response.error)
            .and_then(|error| {
                let message = error.message?.trim().to_string();

                if message.is_empty() {
                    return None;
                }

                match error.code.filter(|code| !code.trim().is_empty()) {
                    Some(code) => Some(format!("{message} ({code})")),
                    None => Some(message),
                }
            })
            .unwrap_or_else(|| "The AI service rejected the request.".to_string());

        return Err(format!("AI request failed ({status}): {detail}"));
    }

    let response: ChatCompletionsResponse = response
        .json()
        .await
        .map_err(|_| "The AI service returned an invalid Chat Completions response.".to_string())?;

    let sql = response
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .ok_or("The AI service returned no SQL.")?;

    if sql.chars().count() > MAX_RESPONSE_CHARS {
        return Err("The AI response is too long.".to_string());
    }

    let sql = strip_markdown_code_fence(&sql);
    let (view_name, sql) = generated_view_name_and_sql(&sql)?;

    // Validate only the SQL body. `normalize_read_only_sql` intentionally strips
    // comments, so preserve the generated view name separately.
    let sql = crate::normalize_read_only_sql(&sql)
        .map_err(|error| format!("The generated SQL was rejected: {error}"))?;

    Ok(format!("-- {view_name}\n{sql};"))
}
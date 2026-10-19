use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{ApiError, emit, invalid_response};

#[derive(Default)]
struct Completion {
    reply: String,
    usage: Value,
    stopped: bool,
    done: bool,
}

impl Completion {
    fn record(&mut self, record: &[u8]) -> Result<Option<String>, ApiError> {
        let text = std::str::from_utf8(record).map_err(|_| invalid_response())?;
        let data = text
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(None);
        }
        if self.done {
            return Err(invalid_response());
        }
        if data == "[DONE]" {
            if !self.stopped || self.reply.trim().is_empty() {
                return Err(invalid_response());
            }
            self.done = true;
            return Ok(None);
        }
        let value: Value = serde_json::from_str(&data).map_err(|_| invalid_response())?;
        if value.get("error").is_some() {
            return Err(invalid_response());
        }
        if let Some(usage) = value
            .get("usage")
            .filter(|u| u.is_object())
            .or_else(|| value.pointer("/x_groq/usage"))
        {
            self.usage = usage.clone();
        }
        let delta = value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(delta) = delta {
            if self.stopped || self.reply.chars().count() + delta.chars().count() > 1600 {
                return Err(invalid_response());
            }
            self.reply.push_str(delta);
        }
        if let Some(reason) = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            if reason != "stop" {
                return Err(invalid_response());
            }
            self.stopped = true;
        }
        Ok(delta.map(str::to_owned))
    }
}

pub(super) async fn completion(
    response: reqwest::Response,
    tx: &mpsc::Sender<Result<Value, ApiError>>,
    sentences: Option<mpsc::Sender<String>>,
) -> Result<Value, ApiError> {
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut record = Vec::new();
    let mut total = 0;
    let mut completion = Completion::default();
    let mut speech = SpeechBuffer::default();
    while let Some(bytes) = stream.next().await {
        let bytes = bytes.map_err(|_| invalid_response())?;
        total += bytes.len();
        if total > 128 * 1024 {
            return Err(invalid_response());
        }
        for byte in bytes {
            if byte != b'\n' {
                pending.push(byte);
                continue;
            }
            if pending.last() == Some(&b'\r') {
                pending.pop();
            }
            if pending.is_empty() {
                if let Some(text) = completion.record(&record)? {
                    emit(tx, json!({"type":"delta", "text":text})).await?;
                    if let Some(sentences) = &sentences {
                        for chunk in speech.push(&text, false) {
                            sentences
                                .send(chunk)
                                .await
                                .map_err(|_| invalid_response())?;
                        }
                    }
                }
                record.clear();
                if completion.done {
                    if let Some(sentences) = &sentences {
                        for chunk in speech.push("", true) {
                            sentences
                                .send(chunk)
                                .await
                                .map_err(|_| invalid_response())?;
                        }
                    }
                    return Ok(
                        json!({"choices":[{"message":{"content":completion.reply}}], "usage":completion.usage}),
                    );
                }
            } else {
                record.append(&mut pending);
                record.push(b'\n');
            }
        }
    }
    Err(invalid_response())
}

#[derive(Default)]
struct SpeechBuffer(String);

impl SpeechBuffer {
    fn push(&mut self, text: &str, finished: bool) -> Vec<String> {
        self.0.push_str(text);
        let mut chunks = Vec::new();
        loop {
            let rest = self.0.trim_start();
            let limit = rest.char_indices().nth(200).map(|(i, _)| i);
            // A following space confirms the boundary across token splits and
            // avoids splitting decimal points. Keep unfinished words buffered.
            let sentence = rest.char_indices().find_map(|(index, character)| {
                let end = index + character.len_utf8();
                let next = rest[end..].chars().next();
                (matches!(character, '.' | '?' | '!' | '\n')
                    && (next.is_some_and(char::is_whitespace) || (finished && next.is_none())))
                .then_some(end)
            });
            let end = match (sentence, limit) {
                (Some(end), Some(limit)) if end <= limit => end,
                (Some(end), None) => end,
                (_, Some(limit)) => rest[..limit]
                    .rfind(char::is_whitespace)
                    .filter(|index| *index > 0)
                    .unwrap_or(limit),
                (None, None) if finished => rest.len(),
                _ => break,
            };
            if end == 0 {
                break;
            }
            let chunk = rest[..end].trim();
            if !chunk.is_empty() {
                chunks.push(chunk.to_owned());
            }
            self.0 = rest[end..].to_owned();
        }
        chunks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deltas_are_incremental_and_require_successful_termination() {
        let mut completion = Completion::default();
        assert_eq!(
            completion
                .record(br#"data: {"choices":[{"delta":{"content":"Hello "}}]}"#)
                .unwrap(),
            Some("Hello ".into())
        );
        assert_eq!(completion.record(r#"data: {"choices":[{"delta":{"content":"bạn"},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":25}}}"#.as_bytes()).unwrap(), Some("bạn".into()));
        completion.record(b"data: [DONE]").unwrap();
        assert_eq!(completion.reply, "Hello bạn");
        assert_eq!(completion.usage["prompt_tokens"], 25);
        assert!(completion.done);
        assert!(Completion::default().record(b"data: [DONE]").is_err());
        assert!(
            Completion::default()
                .record(br#"data: {"choices":[{"finish_reason":"length"}]}"#)
                .is_err()
        );
    }

    #[test]
    fn sentences_stream_without_repeating_words_or_splitting_decimals() {
        let mut speech = SpeechBuffer::default();
        assert!(speech.push("The price is 3.", false).is_empty());
        assert!(
            speech
                .push("14. Good", false)
                .iter()
                .eq(["The price is 3.14."])
        );
        assert!(speech.push(" mor", false).is_empty());
        assert!(speech.push("ning! ", false).iter().eq(["Good morning!"]));
        assert!(speech.push("Last words", false).is_empty());
        assert_eq!(speech.push("", true), ["Last words"]);
        assert!(speech.push("", true).is_empty());
    }

    #[test]
    fn bounds_sentence_chunks_by_unicode_characters_and_flushes_final_fragment() {
        let text = "Hello bạn welcome to English practice ".repeat(30);
        let mut speech = SpeechBuffer::default();
        let mut chunks = Vec::new();
        for character in text.chars() {
            chunks.extend(speech.push(&character.to_string(), false));
        }
        chunks.extend(speech.push("", true));
        assert!(
            chunks
                .iter()
                .all(|text| text.chars().count() <= 200 && !text.is_empty())
        );
        assert_eq!(chunks.join(" "), text.trim());
        let mut speech = SpeechBuffer::default();
        let mut chunks = speech.push(&"界".repeat(401), false);
        chunks.extend(speech.push("", true));
        assert_eq!(
            chunks.iter().map(|s| s.chars().count()).collect::<Vec<_>>(),
            [200, 200, 1]
        );
    }
}

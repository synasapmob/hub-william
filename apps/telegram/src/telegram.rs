use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Update {
    pub callback_query: Option<CallbackQuery>,
    pub message: Option<Message>,
}

#[derive(Deserialize)]
pub struct Message {
    pub chat: Chat,
    pub from: Option<User>,
    pub text: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub data: Option<String>,
    pub from: User,
    pub id: String,
    pub message: Option<CallbackMessage>,
}

#[derive(Deserialize)]
pub struct CallbackMessage {
    pub chat: Chat,
    pub message_id: i64,
}

#[derive(Deserialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Deserialize)]
pub struct User {
    pub first_name: String,
    pub id: i64,
    #[serde(default)]
    pub is_bot: bool,
    pub last_name: Option<String>,
    pub username: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiResult {
    pub ok: bool,
}

/// The single Bot API call a webhook may answer with. Each variant already
/// carries its own `method`, so the untagged form is exactly the JSON Telegram
/// expects in a webhook response body.
#[derive(Serialize)]
#[serde(untagged)]
pub enum Reply {
    Edit(EditMessageText),
    Photo(SendPhoto),
    Text(SendMessage),
}

impl From<SendMessage> for Reply {
    fn from(message: SendMessage) -> Self {
        Self::Text(message)
    }
}

impl From<SendPhoto> for Reply {
    fn from(photo: SendPhoto) -> Self {
        Self::Photo(photo)
    }
}

impl From<EditMessageText> for Reply {
    fn from(edit: EditMessageText) -> Self {
        Self::Edit(edit)
    }
}

#[derive(Serialize)]
pub struct SendMessage {
    chat_id: serde_json::Value,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_markup: Option<InlineKeyboardMarkup>,
    text: String,
}

impl SendMessage {
    pub fn new(chat_id: i64, text: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            method: "sendMessage",
            reply_markup: None,
            text: text.into(),
        }
    }

    /// A channel is addressed by `@name` as often as by id, so the announcement
    /// path takes whichever the operator configured.
    pub fn to_chat(chat_id: String, text: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            method: "sendMessage",
            reply_markup: None,
            text: text.into(),
        }
    }

    pub fn with_keyboard(mut self, keyboard: InlineKeyboardMarkup) -> Self {
        self.reply_markup = Some(keyboard);
        self
    }
}

#[derive(Serialize)]
pub struct SendPhoto {
    caption: String,
    chat_id: i64,
    method: &'static str,
    photo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_markup: Option<InlineKeyboardMarkup>,
}

impl SendPhoto {
    pub fn new(chat_id: i64, photo: impl Into<String>, caption: impl Into<String>) -> Self {
        Self {
            caption: caption.into(),
            chat_id,
            method: "sendPhoto",
            photo: photo.into(),
            reply_markup: None,
        }
    }

    pub fn with_keyboard(mut self, keyboard: InlineKeyboardMarkup) -> Self {
        self.reply_markup = Some(keyboard);
        self
    }
}

#[derive(Serialize)]
pub struct EditMessageText {
    chat_id: i64,
    message_id: i64,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_markup: Option<InlineKeyboardMarkup>,
    text: String,
}

impl EditMessageText {
    pub fn new(chat_id: i64, message_id: i64, text: impl Into<String>) -> Self {
        Self {
            chat_id,
            message_id,
            method: "editMessageText",
            reply_markup: None,
            text: text.into(),
        }
    }

    pub fn with_keyboard(mut self, keyboard: InlineKeyboardMarkup) -> Self {
        self.reply_markup = Some(keyboard);
        self
    }
}

#[derive(Serialize)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Serialize)]
pub struct InlineKeyboardButton {
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<DisabledButton>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style: Option<&'static str>,
    text: String,
}

impl InlineKeyboardButton {
    pub fn callback(text: impl Into<String>, callback_data: impl Into<String>) -> Self {
        Self {
            callback_data: Some(callback_data.into()),
            disabled: None,
            style: None,
            text: text.into(),
            url: None,
        }
    }

    pub fn url(text: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            callback_data: None,
            disabled: None,
            style: None,
            text: text.into(),
            url: Some(url.into()),
        }
    }

    pub fn success_callback(text: impl Into<String>, callback_data: impl Into<String>) -> Self {
        Self {
            style: Some("success"),
            ..Self::callback(text, callback_data)
        }
    }

    pub fn disabled_danger(text: impl Into<String>) -> Self {
        Self {
            callback_data: None,
            disabled: Some(DisabledButton {}),
            style: Some("danger"),
            text: text.into(),
            url: None,
        }
    }
}

#[derive(Serialize)]
pub struct DisabledButton {}

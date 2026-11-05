use super::*;

fn request(provider: AgentProvider) -> PlaygroundChatRequest {
    PlaygroundChatRequest {
        connection_id: Uuid::new_v4(),
        organization_id: None,
        provider,
        model: "test-model".to_owned(),
        messages: vec![
            PlaygroundMessage {
                role: PlaygroundRole::User,
                content: "Hello".to_owned(),
                attachments: vec![],
            },
            PlaygroundMessage {
                role: PlaygroundRole::Assistant,
                content: "Hi".to_owned(),
                attachments: vec![],
            },
            PlaygroundMessage {
                role: PlaygroundRole::User,
                content: "Continue".to_owned(),
                attachments: vec![],
            },
        ],
    }
}

#[test]
fn native_bodies_preserve_text_and_roles() {
    for provider in [
        AgentProvider::Chatgpt,
        AgentProvider::Grok,
        AgentProvider::Deepseek,
    ] {
        let body = request_body(&request(provider)).unwrap();
        assert_eq!(
            body["input"][1],
            json!({"role":"assistant", "content":"Hi"})
        );
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
    }
    let claude = request_body(&request(AgentProvider::Claude)).unwrap();
    assert_eq!(claude["messages"][2]["content"][0]["text"], "Continue");
    assert_eq!(claude["max_tokens"], 4096);
    let gemini = request_body(&request(AgentProvider::Gemini)).unwrap();
    assert_eq!(
        gemini["contents"][1],
        json!({"role":"model", "parts":[{"text":"Hi"}]})
    );
}

#[test]
fn groq_chat_preserves_namespaced_model_ids_and_rejects_other_models() {
    let mut input = request(AgentProvider::Groq);
    for model in [
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
    ] {
        input.model = model.into();
        let body = request_body(&input).unwrap();
        assert_eq!(body["model"], model);
        assert_eq!(body["input"][2]["content"][0]["text"], "Continue");
        assert_eq!(body["stream"], true);
        assert!(body.get("store").is_none());
    }
    for model in [
        "",
        "qwen/qwen3.8-27b ",
        "Qwen/Qwen3.8-27B",
        "qwen/qwen3.6-27b",
        "https://example.com/model",
    ] {
        input.model = model.into();
        assert!(request_body(&input).is_err(), "accepted {model}");
    }
    let mut gemini = request(AgentProvider::Gemini);
    gemini.model = "models/example:generateContent".into();
    assert!(request_body(&gemini).is_err());
}

#[test]
fn rejects_invalid_histories_and_unknown_privileged_fields() {
    let mut input = request(AgentProvider::Chatgpt);
    input.messages.pop();
    assert!(request_body(&input).is_err());
    input.messages.clear();
    assert!(request_body(&input).is_err());
    assert!(serde_json::from_value::<PlaygroundChatRequest>(json!({
            "provider":"chatgpt", "model":"test", "user_id":"other-user", "messages":[{"role":"user", "content":"Hi"}]
        })).is_err());
    assert!(
        serde_json::from_value::<PlaygroundMessage>(json!({"role":"system", "content":"Hi"}))
            .is_err()
    );
}

#[test]
fn native_attachments_are_validated_and_mapped() {
    let image_data = STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    for provider in [
        AgentProvider::Chatgpt,
        AgentProvider::Claude,
        AgentProvider::Gemini,
    ] {
        let mut input = request(provider);
        input.messages[2].attachments = vec![
            PlaygroundAttachment::Text {
                name: "notes.txt".into(),
                text: "File content".into(),
            },
            PlaygroundAttachment::Image {
                name: "image.png".into(),
                media_type: "image/png".into(),
                data: image_data.clone(),
            },
        ];
        let body = request_body(&input).unwrap();
        match provider {
            AgentProvider::Claude => {
                assert_eq!(
                    body["messages"][2]["content"][2]["source"]["data"],
                    image_data
                );
                assert_eq!(
                    body["messages"][2]["content"][1]["text"],
                    "Attached file: notes.txt\nFile content"
                );
            }
            AgentProvider::Gemini => assert_eq!(
                body["contents"][2]["parts"][2]["inlineData"]["data"],
                image_data
            ),
            _ => assert_eq!(
                body["input"][2]["content"][2]["image_url"],
                format!("data:image/png;base64,{image_data}")
            ),
        }
    }
    let mut input = request(AgentProvider::Deepseek);
    input.messages[2]
        .attachments
        .push(PlaygroundAttachment::Image {
            name: "image.png".into(),
            media_type: "image/png".into(),
            data: image_data,
        });
    assert!(request_body(&input).is_err());
    input.provider = AgentProvider::Chatgpt;
    input.messages[2].attachments = vec![PlaygroundAttachment::Image {
        name: "fake.png".into(),
        media_type: "image/png".into(),
        data: STANDARD.encode(b"not an image"),
    }];
    assert!(request_body(&input).is_err());
    input.messages[2].attachments = vec![PlaygroundAttachment::Text {
        name: "notes.txt".into(),
        text: "Text only".into(),
    }];
    input.messages[2].content.clear();
    assert!(request_body(&input).is_ok());
}

#[test]
fn catalogue_uses_existing_names_and_deduplicates_ids() {
    let models = normalize_models(AgentProvider::Gemini, &json!({"data":[{"id":"gemini-3.8-flash-high", "display_name":"One"},{"id":"gemini-3.8-flash-high"},{"id":"gemini-3.8-flash-medium", "name":"Two"},{"id":"gemini-3.8-flash-low"},{"id":"unreviewed-model"},{"name":"invalid"}]}), None).unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[0].name, "One");
    assert_eq!(models[2].name, "gemini-3.8-flash-low");
    assert!(normalize_models(AgentProvider::Gemini, &json!({"unknown":[]}), None).is_err());
    let codex = normalize_models(
        AgentProvider::Chatgpt,
        &json!({"models":[
            {"id":"internal-id", "slug":"gpt-6-astra", "display_name":"GPT-6 Astra"},
            {"slug":"internal-model", "visibility":"Hidden"},
            {"id":"gpt-5.6-sol", "display_name":"GPT-5.6 Sol"}
        ]}),
        Some(&gateway::default_openai_model_catalogue()),
    )
    .unwrap();
    assert_eq!(codex.len(), 2);
    assert_eq!(codex[0].id, "gpt-6-astra");
    assert_eq!(codex[0].name, "GPT-6 Astra");
    assert_eq!(codex[1].id, "gpt-5.6-sol");
}

#[test]
fn current_lineup_only_includes_ids_advertised_by_selected_account() {
    let claude = normalize_models(
        AgentProvider::Claude,
        &json!({"data":[
            {"id":"claude-opus-4-5-20251101"},
            {"id":"claude-opus-5"},
            {"id":"claude-fable-5-1"},
            {"id":"claude-opus-5-5"},
            {"id":"claude-sonnet-5"},
            {"id":"claude-haiku-4-5-20251001"}
        ]}),
        Some(&gateway::default_claude_model_catalogue()),
    )
    .unwrap();
    assert_eq!(
        claude.into_iter().map(|model| model.id).collect::<Vec<_>>(),
        [
            "claude-fable-5-1",
            "claude-opus-5-5",
            "claude-sonnet-5",
            "claude-haiku-4-5-20251001",
        ]
    );

    let codex = normalize_models(
        AgentProvider::Chatgpt,
        &json!({"models":[
            {"slug":"gpt-5.6-sol"},
            {"slug":"gpt-6-astra"},
            {"slug":"gpt-6-sol"}
        ]}),
        Some(&gateway::default_openai_model_catalogue()),
    )
    .unwrap();
    assert_eq!(
        codex.into_iter().map(|model| model.id).collect::<Vec<_>>(),
        ["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]
    );
}

#[test]
fn newly_documented_model_is_not_blocked_by_a_second_picker_list() {
    let docs = json!({"data": [{"id": "gpt-6-new"}]});
    let models = normalize_models(
        AgentProvider::Chatgpt,
        &json!({"models": [{"slug": "gpt-6-new"}, {"slug": "gpt-5.5"}]}),
        Some(&docs),
    )
    .unwrap();
    assert_eq!(
        models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
        ["gpt-6-new"]
    );
}

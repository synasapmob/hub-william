use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use utoipa::OpenApi;

use super::{
    access::{Permission, Role},
    images::{MAXIMUM_IMAGE_BYTES, image_type},
};
use crate::{
    api::{ApiDoc, app},
    core::{AppConfig, AppState},
};

fn state() -> AppState {
    AppState {
        config: AppConfig::default(),
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    }
}

async fn status(method: &str, uri: &str, body: Body) -> StatusCode {
    app(state())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(body)
                .expect("request should build"),
        )
        .await
        .expect("route should respond")
        .status()
}

#[test]
fn each_role_holds_the_permissions_the_dashboard_shows_it() {
    use Permission::{History, Orders, Revenue, Staff, Stock};

    assert_eq!(
        Role::Owner.permissions(),
        &[Orders, History, Stock, Revenue, Staff]
    );
    assert_eq!(
        Role::Manager.permissions(),
        &[Orders, History, Stock, Revenue]
    );
    assert_eq!(Role::Cashier.permissions(), &[Orders, History]);
    assert_eq!(Role::StockKeeper.permissions(), &[Stock]);
}

#[test]
fn roles_and_permissions_are_written_the_way_the_dashboard_reads_them() {
    assert_eq!(serde_json::to_value(Role::Owner).unwrap(), "owner");
    assert_eq!(
        serde_json::to_value(Role::StockKeeper).unwrap(),
        "stock-keeper"
    );
    assert_eq!(serde_json::to_value(Permission::Orders).unwrap(), "orders");
    assert_eq!(serde_json::to_value(Permission::Staff).unwrap(), "staff");
}

#[test]
fn a_picture_is_known_by_its_bytes() {
    assert_eq!(
        image_type(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
        Some("image/png")
    );
    assert_eq!(
        image_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]),
        Some("image/jpeg")
    );
    assert_eq!(image_type(b"GIF87a...."), Some("image/gif"));
    assert_eq!(image_type(b"GIF89a...."), Some("image/gif"));
    assert_eq!(image_type(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
}

#[test]
fn anything_else_does_not_pass_for_a_picture() {
    assert_eq!(image_type(b""), None);
    assert_eq!(
        image_type(b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
        None
    );
    assert_eq!(image_type(b"<?xml version='1.0'?>"), None);
    assert_eq!(image_type(b"RIFF\x24\0\0\0WAVEfmt "), None);
    assert_eq!(image_type(b"#!/bin/sh\n"), None);
}

#[tokio::test]
async fn every_dashboard_route_asks_for_a_session() {
    const PRODUCT: &str = r#"{"hot":false,"image_id":null,"listed":true,"plan":"Pro","price_vnd":1000,"provider":"Claude","variant":null,"warranty":"WF"}"#;
    const NEW_PRODUCT: &str = r#"{"available":1,"hot":false,"image_id":null,"listed":true,"plan":"Pro","price_vnd":1000,"provider":"Claude","variant":null,"warranty":"WF"}"#;

    for (method, uri, body) in [
        ("GET", "/dashboard/session", ""),
        ("GET", "/dashboard/telegram/products", ""),
        ("POST", "/dashboard/telegram/products", NEW_PRODUCT),
        ("PUT", "/dashboard/telegram/products/claude-pro", PRODUCT),
        ("DELETE", "/dashboard/telegram/products/claude-pro", ""),
        (
            "POST",
            "/dashboard/telegram/products/claude-pro/stock",
            r#"{"delta":1}"#,
        ),
        ("POST", "/dashboard/images", "not even a picture"),
        (
            "GET",
            "/dashboard/images/00000000-0000-0000-0000-000000000000",
            "",
        ),
    ] {
        assert_eq!(
            status(method, uri, Body::from(body)).await,
            StatusCode::UNAUTHORIZED,
            "{method} {uri}"
        );
    }
}

#[tokio::test]
async fn an_anonymous_caller_is_unauthorized_not_forbidden() {
    assert_eq!(
        status("GET", "/dashboard/session", Body::empty()).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status("GET", "/dashboard/telegram/products", Body::empty()).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_picture_over_five_mebibytes_is_refused_before_it_is_read() {
    let answer = status(
        "POST",
        "/dashboard/images",
        Body::from(vec![0_u8; MAXIMUM_IMAGE_BYTES + 4096]),
    )
    .await;

    assert_eq!(answer, StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn the_published_document_lists_the_dashboard() {
    let document = ApiDoc::openapi();

    for path in [
        "/dashboard/session",
        "/dashboard/telegram/products",
        "/dashboard/telegram/products/{slug}",
        "/dashboard/telegram/products/{slug}/stock",
        "/dashboard/images",
        "/dashboard/images/{id}",
    ] {
        assert!(
            document.paths.paths.contains_key(path),
            "{path} is not documented"
        );
    }
}

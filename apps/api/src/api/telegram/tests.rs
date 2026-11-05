use chrono::{TimeZone, Utc};

use super::{
    ORDER_REFERENCE_LENGTH, ObserveTelegramContact, SepayTransaction, normalize_contact,
    normalize_language, normalize_reference, order_reference, searchable_content, secrets_match,
    sepay_transferred_at,
};

#[test]
fn contact_normalization_limits_public_metadata() {
    let contact = normalize_contact(ObserveTelegramContact {
        chat_id: 42,
        first_name: "  William  ".to_owned(),
        last_name: Some("  Hub  ".to_owned()),
        telegram_user_id: 99,
        username: Some("@Hub_William".to_owned()),
    })
    .expect("valid Telegram contact");

    assert_eq!(contact.username.as_deref(), Some("hub_william"));
    assert_eq!(contact.first_name, "William");
    assert_eq!(contact.last_name.as_deref(), Some("Hub"));
}

#[test]
fn service_tokens_require_an_exact_match() {
    assert!(secrets_match(b"shared-secret", b"shared-secret"));
    assert!(!secrets_match(b"shared-secret", b"shared-secrex"));
    assert!(!secrets_match(b"shared-secret", b"shared-secret-more"));
}

#[test]
fn language_is_limited_to_the_supported_locales() {
    assert_eq!(normalize_language(" EN ".to_owned()).unwrap(), "en");
    assert_eq!(normalize_language("vi".to_owned()).unwrap(), "vi");
    assert!(normalize_language("fr".to_owned()).is_err());
}

#[test]
fn a_reference_is_normalized_and_bounded() {
    assert_eq!(
        normalize_reference(" 1gs0h75mmx9p ").unwrap(),
        "1GS0H75MMX9P"
    );
    assert!(normalize_reference("").is_err());
    assert!(normalize_reference("1GS0H75MMX9P0").is_err());
    assert!(normalize_reference("1GS0-H75MMX").is_err());
}

#[test]
fn a_generated_reference_matches_the_column_constraint() {
    let reference = order_reference();

    assert_eq!(reference.chars().count(), ORDER_REFERENCE_LENGTH);
    assert_eq!(normalize_reference(&reference).unwrap(), reference);
}

#[test]
fn a_transfer_note_matches_after_a_bank_rewrites_it() {
    let content = searchable_content(&sepay_transaction(Some(
        "CT DEN:520123 cam tien di chill thoi 1gs0h75mmx9p-Ma GD 123",
    )));

    assert!(content.contains("1GS0H75MMX9P"));
    assert!(!content.contains(' '));
}

#[test]
fn a_sepay_payment_code_is_searched_alongside_the_free_text_note() {
    let mut transaction = sepay_transaction(Some("khong co ma"));
    transaction.code = Some("1GS0H75MMX9P".to_owned());

    assert!(searchable_content(&transaction).contains("1GS0H75MMX9P"));
}

#[test]
fn a_sepay_timestamp_is_read_as_vietnamese_local_time() {
    assert_eq!(
        sepay_transferred_at(Some("2026-09-10 15:31:00")),
        Utc.with_ymd_and_hms(2026, 9, 10, 8, 31, 0).single()
    );
    assert!(sepay_transferred_at(None).is_none());
    assert!(sepay_transferred_at(Some("10/09/2026")).is_none());
}

fn sepay_transaction(content: Option<&str>) -> SepayTransaction {
    SepayTransaction {
        account_number: Some("19036951867026".to_owned()),
        code: None,
        content: content.map(str::to_owned),
        gateway: "Techcombank".to_owned(),
        id: 92_704,
        reference_code: Some("TCB.3278907687".to_owned()),
        transaction_date: Some("2026-09-10 15:31:00".to_owned()),
        transfer_amount: 270_000,
        transfer_type: "in".to_owned(),
    }
}

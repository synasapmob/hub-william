use super::{
    model_ids,
    money::{Price, Tokens, request_cost_micro},
    stripe::{signature_header, verify_signature},
};

const PRICE: Price = Price {
    input: 600_000,
    cached: 60_000,
    output: 4_700_000,
};

fn tokens(input: i64, cached: i64, output: i64) -> Tokens {
    Tokens {
        input: Some(input),
        cached: Some(cached),
        output: Some(output),
    }
}

#[test]
fn each_kind_of_token_costs_its_own_price() {
    assert_eq!(
        request_cost_micro(tokens(1_000_000, 0, 0), PRICE),
        Some(600_000)
    );
    assert_eq!(
        request_cost_micro(tokens(1_000_000, 1_000_000, 0), PRICE),
        Some(60_000),
        "cached tokens are part of the input, and cost the cached price instead"
    );
    assert_eq!(
        request_cost_micro(tokens(0, 0, 1_000_000), PRICE),
        Some(4_700_000)
    );
}

#[test]
fn a_request_costs_its_new_input_its_cached_input_and_its_output() {
    // 8,000 new, 92,000 cached and 3,000 output tokens.
    assert_eq!(
        request_cost_micro(tokens(100_000, 92_000, 3_000), PRICE),
        Some(4_800 + 5_520 + 14_100)
    );
}

#[test]
fn a_cost_is_rounded_up_so_the_price_is_never_undercut() {
    // One output token is 4.7 micro-dollars.
    assert_eq!(request_cost_micro(tokens(0, 0, 1), PRICE), Some(5));
    assert_eq!(request_cost_micro(tokens(0, 0, 0), PRICE), Some(0));
}

#[test]
fn a_count_the_provider_did_not_report_costs_nothing() {
    assert_eq!(request_cost_micro(Tokens::default(), PRICE), Some(0));
    assert_eq!(
        request_cost_micro(
            Tokens {
                output: Some(1_000_000),
                ..Tokens::default()
            },
            PRICE
        ),
        Some(4_700_000)
    );
}

#[test]
fn counts_that_make_no_sense_are_held_to_what_they_can_be() {
    // More cached than input is as many cached as there is input.
    assert_eq!(
        request_cost_micro(tokens(1_000_000, 2_000_000, 0), PRICE),
        Some(60_000)
    );
    assert_eq!(request_cost_micro(tokens(-5, -5, -5), PRICE), Some(0));
}

#[test]
fn a_cost_too_large_to_hold_is_none() {
    let dear = Price {
        input: i64::MAX,
        cached: 0,
        output: i64::MAX,
    };

    assert_eq!(request_cost_micro(tokens(i64::MAX, 0, 0), dear), None);
}

#[test]
fn a_model_is_looked_up_under_the_id_it_is_named_by() {
    assert_eq!(model_ids("gpt-6-sol"), ["gpt-6-sol"]);
    assert_eq!(model_ids("openai/gpt-oss-20b"), ["openai/gpt-oss-20b"]);
}

#[test]
fn a_gemini_model_may_carry_the_models_prefix_of_its_url() {
    assert_eq!(model_ids("models/gemini-4-argon"), ["gemini-4-argon"]);
}

#[test]
fn an_effort_variant_is_also_looked_up_as_its_model() {
    // The Gemini gateway picks the effort from the request, so the id without it
    // is the one the price list holds.
    assert_eq!(
        model_ids("gemini-4-argon-high"),
        ["gemini-4-argon-high", "gemini-4-argon"]
    );
    assert_eq!(
        model_ids("models/gemini-4-argon-low"),
        ["gemini-4-argon-low", "gemini-4-argon"]
    );
}

#[test]
fn nothing_is_looked_up_under_an_empty_id() {
    assert_eq!(model_ids(""), [""]);
}

const SECRET: &str = "whsec_test_secret";
const BODY: &str = r#"{"type":"checkout.session.completed"}"#;
const NOW: i64 = 1_800_000_000;

#[test]
fn a_webhook_signed_with_the_secret_is_accepted() {
    let header = signature_header(SECRET, BODY, NOW);

    assert!(verify_signature(SECRET, &header, BODY.as_bytes(), NOW));
}

#[test]
fn a_webhook_signed_with_another_secret_is_refused() {
    let header = signature_header("whsec_someone_else", BODY, NOW);

    assert!(!verify_signature(SECRET, &header, BODY.as_bytes(), NOW));
}

#[test]
fn a_webhook_whose_body_was_changed_is_refused() {
    let header = signature_header(SECRET, BODY, NOW);

    assert!(!verify_signature(
        SECRET,
        &header,
        BODY.replace("completed", "expired").as_bytes(),
        NOW
    ));
}

#[test]
fn a_signature_is_good_for_five_minutes_either_side_of_now() {
    let header = signature_header(SECRET, BODY, NOW);

    assert!(verify_signature(
        SECRET,
        &header,
        BODY.as_bytes(),
        NOW + 300
    ));
    assert!(verify_signature(
        SECRET,
        &header,
        BODY.as_bytes(),
        NOW - 300
    ));
    assert!(!verify_signature(
        SECRET,
        &header,
        BODY.as_bytes(),
        NOW + 301
    ));
    assert!(!verify_signature(
        SECRET,
        &header,
        BODY.as_bytes(),
        NOW - 301
    ));
}

#[test]
fn a_header_that_does_not_say_when_or_what_is_refused() {
    let good = signature_header(SECRET, BODY, NOW);
    let signature = good.split("v1=").nth(1).unwrap();

    for header in [
        String::new(),
        "garbage".to_owned(),
        format!("v1={signature}"),
        format!("t={NOW}"),
        format!("t=not-a-time,v1={signature}"),
        format!("t={NOW},v1=zz{}", &signature[2..]),
        format!("t={NOW},v1={}", &signature[1..]),
        format!("t={NOW},v0={signature}"),
    ] {
        assert!(
            !verify_signature(SECRET, &header, BODY.as_bytes(), NOW),
            "{header}"
        );
    }
}

#[test]
fn any_one_of_several_signatures_may_match() {
    // Stripe signs with the old and the new secret while one is rolled over.
    let good = signature_header(SECRET, BODY, NOW);
    let signature = good.split("v1=").nth(1).unwrap();
    let header = format!("t={NOW},v1={},v1={signature}", "0".repeat(64));

    assert!(verify_signature(SECRET, &header, BODY.as_bytes(), NOW));
}

#[test]
fn an_empty_secret_does_not_vouch_for_a_signature_made_without_one() {
    let header = signature_header("", BODY, NOW);

    // Nothing is configured to accept it: the check is only ever asked with a secret.
    assert!(!verify_signature(SECRET, &header, BODY.as_bytes(), NOW));
}

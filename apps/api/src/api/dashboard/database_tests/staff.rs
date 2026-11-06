//! Who may use the dashboard, and the owner's say over it.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{account, call, owner_and_state, state, support::Order};

fn usernames(body: &Value) -> Vec<&str> {
    body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| member["username"].as_str().unwrap())
        .collect()
}

#[sqlx::test]
async fn the_list_puts_the_owners_first_and_says_what_each_did_today(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let stranger = account(&pool, None).await;
    // The cashier took two orders today and one a week ago; the owner took one.
    Order::new("TODAY0000001")
        .paid("0 seconds")
        .handled(cashier.id, "cash")
        .insert(&pool)
        .await;
    Order::new("TODAY0000002")
        .paid("0 seconds")
        .quantity(2)
        .handled(cashier.id, "usdt")
        .insert(&pool)
        .await;
    Order::new("LASTWEEK0001")
        .paid("7 days")
        .handled(cashier.id, "cash")
        .insert(&pool)
        .await;
    Order::new("OWNERS000001")
        .paid("0 seconds")
        .handled(owner.id, "cash")
        .insert(&pool)
        .await;

    let (status, body) = call(&state, "GET", "/dashboard/staff", Some(&owner.cookie), None).await;

    assert_eq!(status, StatusCode::OK);
    // The owner is first; the others follow by name.
    let names = usernames(&body);
    assert_eq!(names[0], owner.username);
    assert!(names.contains(&cashier.username.as_str()));
    assert!(names.contains(&keeper.username.as_str()));
    assert!(
        !names.contains(&stranger.username.as_str()),
        "an account that is not staff is not listed"
    );
    assert_eq!(names.len(), 3);

    let member = |name: &str| {
        body["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|member| member["username"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(member(&owner.username)["role"], "owner");
    assert_eq!(member(&owner.username)["locked"], true);
    assert_eq!(member(&owner.username)["orders_today"], 1);
    assert_eq!(member(&cashier.username)["role"], "cashier");
    assert_eq!(member(&cashier.username)["locked"], false);
    assert_eq!(member(&cashier.username)["orders_today"], 2);
    assert_eq!(member(&cashier.username)["revenue_today_vnd"], 49_000 * 3);
    assert_eq!(member(&keeper.username)["orders_today"], 0);
    assert_eq!(member(&keeper.username)["revenue_today_vnd"], 0);
    // They have a session, so they have been active.
    assert!(member(&cashier.username)["last_active_at"].is_string());
}

#[sqlx::test]
async fn a_member_whose_access_is_switched_off_is_not_listed(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let active = account(&pool, Some(("cashier", true))).await;
    let off = account(&pool, Some(("cashier", false))).await;

    let (_, body) = call(&state, "GET", "/dashboard/staff", Some(&owner.cookie), None).await;

    let names = usernames(&body);
    assert!(names.contains(&active.username.as_str()));
    assert!(!names.contains(&off.username.as_str()), "{names:?}");
}

#[sqlx::test]
async fn an_owner_adds_a_member_by_the_username_of_their_account(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let newcomer = account(&pool, None).await;

    // Before: the account exists but is not staff, and is turned away.
    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&newcomer.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Typed in capitals with spaces round it, as people do.
    let (status, member) = call(
        &state,
        "POST",
        "/dashboard/staff",
        cookie,
        Some(json!({ "username": format!("  {}  ", newcomer.username.to_uppercase()), "role": "cashier" })),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(member["username"], newcomer.username);
    assert_eq!(member["role"], "cashier");
    assert_eq!(member["id"], newcomer.id.to_string());

    // After: the same session now gets in, with the cashier's permissions.
    let (status, session) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&newcomer.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["role"], "cashier");

    // The row says who added them.
    let added_by: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT created_by FROM dashboard_staff WHERE user_id = $1")
            .bind(newcomer.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(added_by, Some(owner.id));
}

#[sqlx::test]
async fn an_account_that_does_not_exist_or_is_staff_already_cannot_be_added(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let member = account(&pool, Some(("manager", true))).await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/staff",
        cookie,
        Some(json!({ "username": "nobody-has-this", "role": "cashier" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["message"], "No account has that username.");

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/staff",
        cookie,
        Some(json!({ "username": member.username, "role": "cashier" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "already_exists");

    // Their role is untouched by the refused attempt.
    let (_, listing) = call(&state, "GET", "/dashboard/staff", cookie, None).await;
    let theirs = listing["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["username"] == member.username)
        .unwrap();
    assert_eq!(theirs["role"], "manager");
}

#[sqlx::test]
async fn an_owner_can_make_another_account_an_owner_and_the_new_owner_manages_staff(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let candidate = account(&pool, None).await;
    let member = account(&pool, Some(("cashier", true))).await;

    let (status, added) = call(
        &state,
        "POST",
        "/dashboard/staff",
        cookie,
        Some(json!({ "username": candidate.username, "role": "owner" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(added["role"], "owner");

    let (status, changed) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", member.id),
        cookie,
        Some(json!({ "role": "owner" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changed["role"], "owner");

    // A new owner may do what an owner does.
    let (status, listing) = call(
        &state,
        "GET",
        "/dashboard/staff",
        Some(&candidate.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(usernames(&listing)[..3].len(), 3);
    // With three owners none is the last one, so none is locked.
    for entry in listing["members"].as_array().unwrap() {
        if entry["role"] == "owner" {
            assert_eq!(entry["locked"], false, "{entry}");
        }
    }
}

#[sqlx::test]
async fn an_account_that_is_an_owner_already_cannot_be_added_again(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/staff",
        Some(&owner.cookie),
        Some(json!({ "username": owner.username, "role": "manager" })),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["message"], "That account is already staff.");
}

#[sqlx::test]
async fn a_role_can_be_changed_and_takes_effect_at_once(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let member = account(&pool, Some(("cashier", true))).await;

    let (_, before) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue",
        Some(&member.cookie),
        None,
    )
    .await;
    assert_eq!(before["code"], "forbidden");

    let (status, changed) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", member.id),
        cookie,
        Some(json!({ "role": "manager" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changed["role"], "manager");

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue",
        Some(&member.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // An account that is not staff has no role to change.
    let stranger = account(&pool, None).await;
    let (status, _) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", stranger.id),
        cookie,
        Some(json!({ "role": "manager" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn removing_a_member_ends_their_access_at_once(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let member = account(&pool, Some(("manager", true))).await;
    Order::new("DONE00000001")
        .paid("1 hour")
        .handled(member.id, "cash")
        .insert(&pool)
        .await;

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&member.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/staff/{}", member.id),
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Their session still lives, but the dashboard is closed to them.
    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&member.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // What they sold stays on the books, under their account.
    let (_, sales) = call(&state, "GET", "/dashboard/telegram/sales", cookie, None).await;
    assert_eq!(sales["orders"][0]["handled_by"], member.username);

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/staff/{}", member.id),
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn the_last_owner_cannot_be_given_another_role_or_removed_and_says_so(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let other = account(&pool, Some(("manager", true))).await;
    // The only owner is the only one who can ask, so ask as them, of themselves.
    let (status, body) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", owner.id),
        Some(&owner.cookie),
        Some(json!({ "role": "manager" })),
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("at least one owner"),
        "{body}"
    );
    let (_, listing) = call(&state, "GET", "/dashboard/staff", Some(&owner.cookie), None).await;
    let theirs = listing["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == owner.id.to_string())
        .unwrap();
    assert_eq!(theirs["role"], "owner");
    assert_eq!(theirs["locked"], true);
    // Another member is not locked.
    let others = listing["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == other.id.to_string())
        .unwrap();
    assert_eq!(others["locked"], false);
}

#[sqlx::test]
async fn an_owner_can_be_demoted_or_removed_once_another_owner_stands(pool: PgPool) {
    let (state, first) = owner_and_state(pool.clone()).await;
    let second = account(&pool, Some(("owner", true))).await;

    // Either can be demoted by the other.
    let (status, changed) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", first.id),
        Some(&second.cookie),
        Some(json!({ "role": "manager" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changed["role"], "manager");

    // Now the second is the last, and cannot follow.
    let (status, _) = call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", second.id),
        Some(&second.cookie),
        Some(json!({ "role": "cashier" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // The demoted one is no owner now: they may not manage staff.
    let (status, _) = call(&state, "GET", "/dashboard/staff", Some(&first.cookie), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Make them an owner again, and the other may then be removed by them.
    call(
        &state,
        "PUT",
        &format!("/dashboard/staff/{}", first.id),
        Some(&second.cookie),
        Some(json!({ "role": "owner" })),
    )
    .await;
    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/staff/{}", second.id),
        Some(&first.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[sqlx::test]
async fn two_owners_demoting_each_other_at_the_same_moment_leave_one(pool: PgPool) {
    let (state, first) = owner_and_state(pool.clone()).await;
    let second = account(&pool, Some(("owner", true))).await;
    let ask = |by: &super::Account, of: &super::Account| {
        call(
            &state,
            "PUT",
            Box::leak(format!("/dashboard/staff/{}", of.id).into_boxed_str()),
            Some(Box::leak(by.cookie.clone().into_boxed_str())),
            Some(json!({ "role": "cashier" })),
        )
    };

    let ((one, _), (two, _)) = tokio::join!(ask(&first, &second), ask(&second, &first));

    let mut statuses = [one, two];
    statuses.sort();
    // One was done; the other found it would leave the shop with none, or no longer
    // had the rights to ask.
    assert_eq!(statuses[0], StatusCode::OK, "{statuses:?}");
    let owners: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM dashboard_staff WHERE role = 'owner' AND active")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owners, 1);
}

#[sqlx::test]
async fn nobody_removes_themselves_even_with_another_owner_standing(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    account(&pool, Some(("owner", true))).await;

    let (status, body) = call(
        &state,
        "DELETE",
        &format!("/dashboard/staff/{}", owner.id),
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["message"], "You cannot remove yourself.");
    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&owner.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test]
async fn a_manager_cannot_remove_an_owner(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let manager = account(&pool, Some(("manager", true))).await;

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/staff/{}", owner.id),
        Some(&manager.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn only_an_owner_manages_staff(pool: PgPool) {
    let state = state(pool.clone());
    let target = account(&pool, Some(("cashier", true))).await;

    for role in ["manager", "cashier", "stock-keeper"] {
        let member = account(&pool, Some((role, true))).await;

        for (method, uri, body) in [
            ("GET".to_owned(), "/dashboard/staff".to_owned(), None),
            (
                "POST".to_owned(),
                "/dashboard/staff".to_owned(),
                Some(json!({ "username": "x", "role": "cashier" })),
            ),
            (
                "PUT".to_owned(),
                format!("/dashboard/staff/{}", target.id),
                Some(json!({ "role": "manager" })),
            ),
            (
                "DELETE".to_owned(),
                format!("/dashboard/staff/{}", target.id),
                None,
            ),
        ] {
            let (status, _) = call(&state, &method, &uri, Some(&member.cookie), body).await;

            assert_eq!(status, StatusCode::FORBIDDEN, "{role} {method} {uri}");
        }
    }
}

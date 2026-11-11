//! The accounts a Telegram package hands to a buyer the moment they have paid.
//!
//! They are loaded in advance, one `email|password` line each, and kept
//! encrypted with a key that lives in the environment, never in the database, so
//! a copy of the database alone shows nothing readable. An account leaves here in
//! one place only, `delivery_for_order`, and only to the buyer whose paid order it
//! was handed to. Nothing here puts one in an error message or a log: a line that
//! is refused is refused with a reason that does not quote it.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use uuid::Uuid;

use crate::{
    api::telegram::catalogue::has_open_orders,
    core::{ApiError, AppState},
};

pub(crate) const MAXIMUM_ACCOUNTS_PER_LOAD: usize = 1000;
/// A package that hands out accounts sells at most this many in one order, so the
/// accounts of one order always fit in the one Telegram message that carries them
/// (4096 characters; a line is at most 300).
pub(crate) const MAXIMUM_ACCOUNTS_PER_ORDER: i32 = 10;
const MAXIMUM_ACCOUNT_CHARACTERS: usize = 300;
const LINE_PURPOSE: &[u8] = b"hub-william telegram stock account fingerprint v1";
const EMAIL_PURPOSE: &[u8] = b"hub-william telegram stock account email v1";

const NO_KEY: &str = "Loading accounts needs STOCK_ENCRYPTION_KEY, which is not set.";

type HmacSha256 = Hmac<Sha256>;

/// An account line as it is stored: the nonce and what it sealed.
struct Sealed {
    ciphertext: Vec<u8>,
    nonce: [u8; 12],
}

/// Who is acting on the accounts of a package. Owners and managers may change any
/// account; anyone else (a collaborator who only loads stock) only their own.
pub(crate) struct Actor {
    pub id: Uuid,
    pub manages_all: bool,
}

impl Actor {
    fn may_change(&self, loaded_by: Option<Uuid>) -> bool {
        self.manages_all || loaded_by == Some(self.id)
    }
}

/// What a load did, for the page to report. Never the accounts themselves.
pub(crate) struct Loaded {
    pub added: i32,
    pub available: i32,
    /// Lines left alone because the package already holds exactly that account.
    pub duplicates: i32,
}

/// Seals one line. The row's id is bound in as associated data, so a ciphertext
/// copied onto another row does not open there.
fn seal(key: &[u8; 32], id: Uuid, line: &str) -> Result<Sealed, ApiError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let mut nonce = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: line.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| ApiError::Internal)?;

    Ok(Sealed { ciphertext, nonce })
}

/// Opens a line sealed for this row.
pub(crate) fn open(
    key: &[u8; 32],
    id: Uuid,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<String, ApiError> {
    if nonce.len() != 12 {
        return Err(ApiError::Internal);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| ApiError::Internal)?;

    String::from_utf8(plaintext).map_err(|_| ApiError::Internal)
}

/// A keyed hash of some text, so a repeat is noticed without keeping the text
/// readable. Each `purpose` has a key of its own, derived from the encryption key,
/// so it cannot be tried against guesses without it.
fn fingerprint(key: &[u8; 32], purpose: &[u8], text: &str) -> Result<[u8; 32], ApiError> {
    let mut derive = <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    derive.update(purpose);
    let subkey = derive.finalize().into_bytes();

    let mut mac = <HmacSha256 as Mac>::new_from_slice(&subkey).map_err(|_| ApiError::Internal)?;
    mac.update(text.as_bytes());

    Ok(mac.finalize().into_bytes().into())
}

/// What makes two lines the same account: the email without regard to case, and
/// the password exactly. The line itself is kept and delivered as it was typed.
fn identity_of(line: &str) -> String {
    match line.split_once('|') {
        Some((_, password)) => format!("{}|{password}", email_of(line)),
        None => email_of(line),
    }
}

/// The email of a normalised account line, in lower case.
fn email_of(line: &str) -> String {
    line.split_once('|')
        .map_or(line, |(email, _)| email)
        .trim()
        .to_lowercase()
}

/// An email with most of it hidden, enough to tell accounts apart on a page:
/// `j***@gmail.com`.
fn mask_email(line: &str) -> String {
    let email = line.split_once('|').map_or(line, |(email, _)| email).trim();
    let mut first = email.chars();
    let head: String = first.next().into_iter().collect();

    match email.split_once('@') {
        Some((_, domain)) => format!("{head}***@{domain}"),
        None => format!("{head}***"),
    }
}

/// The lines of a pasted block. Blank lines are skipped, each line is
/// `email|password`, and the spaces around the bar are dropped so the same
/// account typed two ways is still one account. A refusal says what is wrong
/// and never quotes the line.
pub(crate) fn parse_accounts(text: &str) -> Result<Vec<String>, ApiError> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    if lines.is_empty() {
        return Err(ApiError::Validation("Paste at least one account."));
    }
    if lines.len() > MAXIMUM_ACCOUNTS_PER_LOAD {
        return Err(ApiError::Validation(
            "At most 1000 accounts can be loaded at a time.",
        ));
    }

    lines
        .into_iter()
        .map(|line| {
            if line.chars().count() > MAXIMUM_ACCOUNT_CHARACTERS {
                return Err(ApiError::Validation(
                    "An account line is at most 300 characters.",
                ));
            }
            if line.chars().any(char::is_control) {
                return Err(ApiError::Validation(
                    "An account line cannot contain control characters.",
                ));
            }

            match line.split_once('|') {
                Some((email, password))
                    if !email.trim().is_empty() && !password.trim().is_empty() =>
                {
                    Ok(format!("{}|{}", email.trim(), password.trim()))
                }
                _ => Err(ApiError::Validation(
                    "Every account line must be an email and a password separated by |.",
                )),
            }
        })
        .collect()
}

/// Puts accounts on a package that hands them out, and brings its count to the
/// number not yet sold. The count is recounted rather than added to, so it
/// cannot drift from the accounts it describes.
///
/// A line is a unit of stock whatever its email: two lines with the same email and
/// different passwords are two accounts. Only the same line again, which would
/// hand one account to two buyers, is counted as a duplicate and left alone.
pub(crate) async fn load_accounts(
    state: &AppState,
    slug: &str,
    lines: &[String],
    actor: &Actor,
) -> Result<Loaded, ApiError> {
    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // Locked, so a load and a sale of the same package take turns.
    let (product_id, delivers) = sqlx::query_as::<_, (Uuid, bool)>(
        "SELECT id, delivers_accounts FROM telegram_products WHERE slug = $1 FOR UPDATE",
    )
    .bind(slug)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    if !delivers {
        return Err(ApiError::Validation(
            "That package does not hand out accounts.",
        ));
    }

    let (mut added, mut duplicates) = (0_i32, 0_i32);
    for line in lines {
        if insert_account(&mut database, &key, product_id, line, actor.id).await? {
            added += 1;
        } else {
            duplicates += 1;
        }
    }

    let available = sqlx::query_scalar::<_, i32>(
        "UPDATE telegram_products
         SET available = (
                 SELECT COUNT(*) FROM telegram_stock_accounts
                 WHERE product_id = $1 AND order_reference IS NULL
             )::INT,
             updated_at = NOW()
         WHERE id = $1
         RETURNING available",
    )
    .bind(product_id)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;

    if added > 0 {
        record_change(&mut database, product_id, added, available, actor.id).await?;
    }

    database.commit().await.map_err(database_error)?;

    Ok(Loaded {
        added,
        available,
        duplicates,
    })
}

/// Makes a package hand out accounts, or stop. It runs inside the transaction that
/// edits the package, so a refusal undoes the whole edit.
///
/// Turning it on makes the count the number of accounts not sold, which for a
/// package that never held any is 0: the count typed in by hand is gone, and the
/// package is sold out until accounts are loaded. It is refused while buyers have
/// orders open, since what they are handed is decided when they pay. Turning it
/// off is refused while the package still holds accounts not sold, so none is left
/// behind that nobody can load, list or sell; the accounts already sold stay as the
/// record of what was handed out, and the count is set to 0, the number of accounts
/// not sold.
pub(crate) async fn set_delivers_accounts(
    database: &mut sqlx::PgConnection,
    slug: &str,
    delivers: bool,
    changed_by: Uuid,
) -> Result<(), ApiError> {
    let (product_id, current, count_now) = sqlx::query_as::<_, (Uuid, bool, i32)>(
        "SELECT id, delivers_accounts, available FROM telegram_products
         WHERE slug = $1 FOR UPDATE",
    )
    .bind(slug)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if current == delivers {
        return Ok(());
    }

    let unsold = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM telegram_stock_accounts
         WHERE product_id = $1 AND order_reference IS NULL",
    )
    .bind(product_id)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)? as i32;

    if delivers {
        if has_open_orders(&mut *database, slug).await? {
            return Err(ApiError::Validation(
                "Buyers have orders open for this package. Try again once they have paid or run out.",
            ));
        }
        sqlx::query(
            "UPDATE telegram_products
             SET delivers_accounts = TRUE, available = $2, updated_at = NOW()
             WHERE id = $1",
        )
        .bind(product_id)
        .bind(unsold)
        .execute(&mut *database)
        .await
        .map_err(database_error)?;
        if unsold != count_now {
            record_change(database, product_id, unsold - count_now, unsold, changed_by).await?;
        }

        return Ok(());
    }

    if unsold > 0 {
        return Err(ApiError::Validation(
            "This package still holds accounts that are not sold. Take them out first, then turn this off.",
        ));
    }
    // The count is the number of accounts not sold, which is none: it is set so,
    // so a count that had drifted does not outlive the accounts it described.
    sqlx::query(
        "UPDATE telegram_products
         SET delivers_accounts = FALSE, available = 0, updated_at = NOW()
         WHERE id = $1",
    )
    .bind(product_id)
    .execute(&mut *database)
    .await
    .map_err(database_error)?;
    if count_now != 0 {
        record_change(database, product_id, -count_now, 0, changed_by).await?;
    }

    Ok(())
}

/// Seals one line and puts it in stock. False when the package already holds that
/// exact account, sold or not, which it keeps unique.
async fn insert_account(
    database: &mut sqlx::PgConnection,
    key: &[u8; 32],
    product_id: Uuid,
    line: &str,
    loaded_by: Uuid,
) -> Result<bool, ApiError> {
    let id = Uuid::new_v4();
    let sealed = seal(key, id, line)?;
    let inserted = sqlx::query(
        "INSERT INTO telegram_stock_accounts
            (id, product_id, nonce, ciphertext, fingerprint, email_fingerprint, loaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (product_id, fingerprint) DO NOTHING",
    )
    .bind(id)
    .bind(product_id)
    .bind(sealed.nonce.as_slice())
    .bind(&sealed.ciphertext)
    .bind(fingerprint(key, LINE_PURPOSE, &identity_of(line))?.as_slice())
    .bind(fingerprint(key, EMAIL_PURPOSE, &email_of(line))?.as_slice())
    .bind(loaded_by)
    .execute(database)
    .await
    .map_err(database_error)?
    .rows_affected();

    Ok(inserted == 1)
}

async fn record_change(
    database: &mut sqlx::PgConnection,
    product_id: Uuid,
    delta: i32,
    available_after: i32,
    changed_by: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO telegram_stock_changes (id, product_id, delta, available_after, changed_by)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(product_id)
    .bind(delta)
    .bind(available_after)
    .bind(changed_by)
    .execute(database)
    .await
    .map_err(database_error)?;

    Ok(())
}

/// One account as a page lists it. The email is hidden but for its first letter
/// and its domain, and the password is not here at all.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct StockAccount {
    pub email_hint: String,
    pub id: Uuid,
    pub loaded_at: chrono::DateTime<chrono::Utc>,
    pub loaded_by: Option<String>,
    /// The order it was handed to, once it has been.
    pub order_reference: Option<String>,
    /// The package it belongs to, by its slug and by its name.
    pub product_slug: String,
    pub product_title: String,
    pub sold_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// How many accounts there are in each standing, under the search.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct AccountCounts {
    pub all: i64,
    pub sold: i64,
    pub unsold: i64,
}

/// One page of accounts, and what the search finds in all.
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct AccountPage {
    pub accounts: Vec<StockAccount>,
    /// How many accounts each standing has under the search, whichever is shown.
    pub counts: AccountCounts,
    /// How many the standing and the search match, across every page.
    pub total: i64,
}

/// What to look for. Every part narrows; an empty search is every account the
/// actor may see.
pub(crate) struct AccountSearch<'a> {
    pub limit: i64,
    pub offset: i64,
    /// Only this package, by its slug.
    pub product: Option<&'a str>,
    /// An email in full, an order reference, a package's name or a loader's
    /// username, in part. An email is found by its keyed hash, not by reading.
    pub query: Option<&'a str>,
    /// `Some(true)` only sold, `Some(false)` only unsold.
    pub sold: Option<bool>,
}

/// Everything after `FROM`, but for the standing, shared by the page and its counts.
const SEARCHED: &str = "FROM telegram_stock_accounts AS account
     JOIN telegram_products AS product ON product.id = account.product_id
     JOIN telegram_providers AS provider ON provider.id = product.provider_id
     LEFT JOIN users AS loader ON loader.id = account.loaded_by
     WHERE ($1::text IS NULL OR product.slug = $1)
       AND ($2 OR account.loaded_by = $3)
       AND ($4::text IS NULL
            OR account.email_fingerprint = $5
            OR account.order_reference ILIKE $4
            OR loader.username ILIKE $4
            OR (provider.name || ' ' || product.plan) ILIKE $4)";

/// A `LIKE` pattern that matches `text` anywhere in a value, whatever characters
/// it holds.
fn contains_pattern(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");

    format!("%{escaped}%")
}

/// The accounts that match, newest first. `actor` sees all of them or, if it only
/// loads stock, the ones it loaded. With a `product`, one that does not hand out
/// accounts is `NotFound`.
pub(crate) async fn search_accounts(
    state: &AppState,
    search: &AccountSearch<'_>,
    actor: &Actor,
) -> Result<AccountPage, ApiError> {
    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;

    if let Some(slug) = search.product {
        let delivers = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM telegram_products WHERE slug = $1 AND delivers_accounts)",
        )
        .bind(slug)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?;
        if !delivers {
            return Err(ApiError::NotFound);
        }
    }

    let pattern = search.query.map(contains_pattern);
    let email = search
        .query
        .map(|query| fingerprint(&key, EMAIL_PURPOSE, &query.to_lowercase()))
        .transpose()?;

    type Row = (
        Uuid,
        Vec<u8>,
        Vec<u8>,
        Option<String>,
        Option<chrono::DateTime<chrono::Utc>>,
        chrono::DateTime<chrono::Utc>,
        Option<String>,
        String,
        String,
        Option<String>,
    );
    let rows = sqlx::query_as::<_, Row>(&format!(
        "SELECT account.id, account.nonce, account.ciphertext, account.order_reference,
                account.sold_at, account.created_at, loader.username,
                product.slug, product.plan, product.variant
         {SEARCHED}
           AND ($6::boolean IS NULL OR (account.order_reference IS NOT NULL) = $6)
         ORDER BY account.created_at DESC, account.id
         LIMIT $7 OFFSET $8"
    ))
    .bind(search.product)
    .bind(actor.manages_all)
    .bind(actor.id)
    .bind(pattern.as_deref())
    .bind(email.as_ref().map(<[u8; 32]>::as_slice))
    .bind(search.sold)
    .bind(search.limit)
    .bind(search.offset)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let (unsold, sold) = sqlx::query_as::<_, (i64, i64)>(&format!(
        "SELECT COUNT(*) FILTER (WHERE account.order_reference IS NULL),
                COUNT(*) FILTER (WHERE account.order_reference IS NOT NULL)
         {SEARCHED}"
    ))
    .bind(search.product)
    .bind(actor.manages_all)
    .bind(actor.id)
    .bind(pattern.as_deref())
    .bind(email.as_ref().map(<[u8; 32]>::as_slice))
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;

    let accounts = rows
        .into_iter()
        .map(
            |(
                id,
                nonce,
                ciphertext,
                order_reference,
                sold_at,
                loaded_at,
                loaded_by,
                slug,
                plan,
                variant,
            )| {
                let product_title = match variant {
                    Some(variant) => format!("{plan} ({variant})"),
                    None => plan,
                };

                Ok(StockAccount {
                    email_hint: mask_email(&open(&key, id, &nonce, &ciphertext)?),
                    id,
                    loaded_at,
                    loaded_by,
                    order_reference,
                    product_slug: slug,
                    product_title,
                    sold_at,
                })
            },
        )
        .collect::<Result<Vec<_>, ApiError>>()?;

    Ok(AccountPage {
        accounts,
        counts: AccountCounts {
            all: unsold + sold,
            sold,
            unsold,
        },
        total: match search.sold {
            None => unsold + sold,
            Some(true) => sold,
            Some(false) => unsold,
        },
    })
}

/// Takes an unsold account out of stock and lowers the count by one. An account
/// that is sold, that is not there, or that `actor` may not change is `NotFound`:
/// the three look the same, so a collaborator learns nothing about accounts that
/// are not theirs.
pub(crate) async fn delete_account(
    state: &AppState,
    id: Uuid,
    actor: &Actor,
) -> Result<i32, ApiError> {
    let mut database = state.pool.begin().await.map_err(database_error)?;

    let product_id = sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM telegram_stock_accounts
         WHERE id = $1 AND order_reference IS NULL AND ($2 OR loaded_by = $3)
         RETURNING product_id",
    )
    .bind(id)
    .bind(actor.manages_all)
    .bind(actor.id)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    // Lowered by one, not recounted, as a sale does: a recount would miss a sale
    // that has not committed yet.
    let available = sqlx::query_scalar::<_, i32>(
        "UPDATE telegram_products
         SET available = GREATEST(available - 1, 0), updated_at = NOW()
         WHERE id = $1
         RETURNING available",
    )
    .bind(product_id)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;

    record_change(&mut database, product_id, -1, available, actor.id).await?;
    database.commit().await.map_err(database_error)?;

    Ok(available)
}

/// Changes the email and/or the password of an account that is not sold. What is
/// left out is kept. The account is read, changed and sealed again on the server,
/// so the page never needs the password it does not show. An account that is sold,
/// that is not there, or that `actor` may not change is `NotFound`. A change that
/// would make this account exactly the same as another of the package is refused;
/// sharing an email with one is not.
pub(crate) async fn update_account(
    state: &AppState,
    id: Uuid,
    actor: &Actor,
    email: Option<&str>,
    password: Option<&str>,
) -> Result<String, ApiError> {
    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;

    let email = email.map(str::trim).filter(|value| !value.is_empty());
    let password = password.map(str::trim).filter(|value| !value.is_empty());
    if email.is_none() && password.is_none() {
        return Err(ApiError::Validation(
            "Give a new email, a new password, or both.",
        ));
    }
    // One line each: a break or a bar would change what the account is made of.
    if [email, password]
        .into_iter()
        .flatten()
        .any(|value| value.contains(['\n', '\r']) || value.chars().any(char::is_control))
        || email.is_some_and(|value| value.contains('|'))
    {
        return Err(ApiError::Validation(
            "An email and a password are one line each, and an email has no | in it.",
        ));
    }

    let mut database = state.pool.begin().await.map_err(database_error)?;

    let (product_id, nonce, ciphertext, loaded_by, sold) =
        sqlx::query_as::<_, (Uuid, Vec<u8>, Vec<u8>, Option<Uuid>, bool)>(
            "SELECT product_id, nonce, ciphertext, loaded_by, order_reference IS NOT NULL
         FROM telegram_stock_accounts WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&mut *database)
        .await
        .map_err(database_error)?
        .ok_or(ApiError::NotFound)?;
    if sold || !actor.may_change(loaded_by) {
        return Err(ApiError::NotFound);
    }

    // Locked, so a load and this change of the same package take turns.
    sqlx::query("SELECT 1 FROM telegram_products WHERE id = $1 FOR UPDATE")
        .bind(product_id)
        .execute(&mut *database)
        .await
        .map_err(database_error)?;

    let current = open(&key, id, &nonce, &ciphertext)?;
    let (current_email, current_password) = current.split_once('|').ok_or(ApiError::Internal)?;
    let line = format!(
        "{}|{}",
        email.unwrap_or(current_email),
        password.unwrap_or(current_password)
    );
    if line == current {
        return Err(ApiError::Validation(
            "That is the account as it already is.",
        ));
    }
    // The same limit as when it is loaded.
    if line.chars().count() > MAXIMUM_ACCOUNT_CHARACTERS {
        return Err(ApiError::Validation(
            "An account line is at most 300 characters.",
        ));
    }

    let line_fingerprint = fingerprint(&key, LINE_PURPOSE, &identity_of(&line))?;
    let email_fingerprint = fingerprint(&key, EMAIL_PURPOSE, &email_of(&line))?;
    let clash = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
             SELECT 1 FROM telegram_stock_accounts
             WHERE product_id = $1 AND id <> $2 AND fingerprint = $3
         )",
    )
    .bind(product_id)
    .bind(id)
    .bind(line_fingerprint.as_slice())
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;
    if clash {
        return Err(ApiError::Validation(
            "That account is already in stock for this package.",
        ));
    }

    let sealed = seal(&key, id, &line)?;
    let changed = sqlx::query(
        "UPDATE telegram_stock_accounts
         SET nonce = $2, ciphertext = $3, fingerprint = $4, email_fingerprint = $5
         WHERE id = $1 AND order_reference IS NULL",
    )
    .bind(id)
    .bind(sealed.nonce.as_slice())
    .bind(&sealed.ciphertext)
    .bind(line_fingerprint.as_slice())
    .bind(email_fingerprint.as_slice())
    .execute(&mut *database)
    .await
    .map_err(database_error)?
    .rows_affected();
    // Sold while this was happening.
    if changed == 0 {
        return Err(ApiError::NotFound);
    }

    database.commit().await.map_err(database_error)?;

    Ok(mask_email(&line))
}

/// Accounts, opened for the one person who asked and proved who they are, in the
/// order they were asked for. Each look is recorded before anything is opened:
/// if the record cannot be made, they are given nothing. An account that is
/// not there makes the whole request `NotFound`.
pub(crate) async fn reveal_accounts(
    state: &AppState,
    ids: &[Uuid],
    viewed_by: Uuid,
) -> Result<Vec<(Uuid, String)>, ApiError> {
    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;
    let ids = distinct(ids)?;

    let rows = sqlx::query_as::<_, (Uuid, Vec<u8>, Vec<u8>)>(
        "SELECT id, nonce, ciphertext FROM telegram_stock_accounts WHERE id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    if rows.len() != ids.len() {
        return Err(ApiError::NotFound);
    }

    sqlx::query(
        "INSERT INTO telegram_stock_account_views (id, account_id, viewed_by)
         SELECT record, account, $3 FROM UNNEST($1::uuid[], $2::uuid[]) AS looked(record, account)",
    )
    .bind(ids.iter().map(|_| Uuid::new_v4()).collect::<Vec<_>>())
    .bind(&ids)
    .bind(viewed_by)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;

    let by_id: std::collections::HashMap<Uuid, (Vec<u8>, Vec<u8>)> = rows
        .into_iter()
        .map(|(id, nonce, ciphertext)| (id, (nonce, ciphertext)))
        .collect();

    ids.into_iter()
        .map(|id| {
            let (nonce, ciphertext) = by_id.get(&id).ok_or(ApiError::NotFound)?;

            Ok((id, open(&key, id, nonce, ciphertext)?))
        })
        .collect()
}

/// The ids asked for, once each and in the order given. Between 1 and 1,000.
fn distinct(ids: &[Uuid]) -> Result<Vec<Uuid>, ApiError> {
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<Uuid> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();

    if ids.is_empty() {
        return Err(ApiError::Validation("Choose at least one account."));
    }
    if ids.len() > MAXIMUM_ACCOUNTS_PER_LOAD {
        return Err(ApiError::Validation(
            "At most 1000 accounts can be opened at a time.",
        ));
    }

    Ok(ids)
}

/// What editing a block of accounts did, or would do.
pub(crate) struct Edited {
    /// Accounts put in stock that were not in the block opened.
    pub added: i32,
    /// The count of the package after the edit.
    pub available: i32,
    /// Accounts whose line is not what it was.
    pub changed: i32,
    /// Lines left out because the package already holds exactly that account.
    pub duplicates: i32,
    /// Accounts taken out of stock because their line is gone from the block.
    pub removed: i32,
}

const STALE: &str =
    "Some of these accounts were sold or removed while you were editing. Open them again.";

/// Brings the accounts opened (`ids`, of one package, all unsold) to the block of
/// lines the owner left, as if the block were the list. A line still there is
/// untouched; a line that is not is paired with a new line of the same email, or
/// failing that the next new line, and rewritten in place, so its id, loader and
/// date stay; what is left over is taken out of stock or put in. With `apply`
/// false nothing is written and the answer is what would be done.
///
/// Accounts the block never opened are not touched, so a collaborator's load
/// made meanwhile survives. If any account opened was sold or removed since, the
/// edit is refused as a whole, since the block no longer describes the package.
pub(crate) async fn edit_accounts(
    state: &AppState,
    slug: &str,
    ids: &[Uuid],
    lines: &[String],
    actor: &Actor,
    apply: bool,
) -> Result<Edited, ApiError> {
    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;
    let ids = distinct(ids)?;

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // Locked, so an edit and a sale or a load of the same package take turns.
    let (product_id, delivers, available_now) = sqlx::query_as::<_, (Uuid, bool, i32)>(
        "SELECT id, delivers_accounts, available FROM telegram_products WHERE slug = $1 FOR UPDATE",
    )
    .bind(slug)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if !delivers {
        return Err(ApiError::Validation(
            "That package does not hand out accounts.",
        ));
    }

    let rows = sqlx::query_as::<_, (Uuid, Vec<u8>, Vec<u8>, bool)>(
        "SELECT id, nonce, ciphertext, order_reference IS NOT NULL
         FROM telegram_stock_accounts
         WHERE product_id = $1 AND id = ANY($2)
         FOR UPDATE",
    )
    .bind(product_id)
    .bind(&ids)
    .fetch_all(&mut *database)
    .await
    .map_err(database_error)?;
    if rows.len() != ids.len() || rows.iter().any(|(_, _, _, sold)| *sold) {
        return Err(ApiError::Validation(STALE));
    }
    let by_id: std::collections::HashMap<Uuid, (Vec<u8>, Vec<u8>)> = rows
        .into_iter()
        .map(|(id, nonce, ciphertext, _)| (id, (nonce, ciphertext)))
        .collect();
    // The accounts as the block listed them: the order they were asked for.
    let opened = ids
        .iter()
        .map(|id| {
            let (nonce, ciphertext) = by_id.get(id).ok_or(ApiError::NotFound)?;

            Ok((*id, open(&key, *id, nonce, ciphertext)?))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    // A line that is still there stays as it is.
    let mut waiting: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (index, (_, line)) in opened.iter().enumerate() {
        waiting.entry(identity_of(line)).or_default().push(index);
    }
    let mut kept = vec![false; opened.len()];
    let mut fresh: Vec<&String> = Vec::new();
    for line in lines {
        match waiting
            .get_mut(&identity_of(line))
            .filter(|queue| !queue.is_empty())
            .map(|queue| queue.remove(0))
        {
            Some(index) => kept[index] = true,
            None => fresh.push(line),
        }
    }
    let gone: Vec<usize> = (0..opened.len()).filter(|index| !kept[*index]).collect();

    // A line that is gone is rewritten as the new line of the same email, if
    // there is one, so changing a password keeps the account; then as the next new
    // line. What finds no partner is taken out, or put in.
    let mut taken_fresh = vec![false; fresh.len()];
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut unpaired: Vec<usize> = Vec::new();
    for &index in &gone {
        let email = email_of(&opened[index].1);
        match (0..fresh.len()).find(|f| !taken_fresh[*f] && email_of(fresh[*f]) == email) {
            Some(f) => {
                taken_fresh[f] = true;
                pairs.push((index, f));
            }
            None => unpaired.push(index),
        }
    }
    let mut spare: Vec<usize> = (0..fresh.len()).filter(|f| !taken_fresh[*f]).collect();
    spare.reverse();
    let mut removals: Vec<Uuid> = Vec::new();
    for index in unpaired {
        match spare.pop() {
            Some(f) => pairs.push((index, f)),
            None => removals.push(opened[index].0),
        }
    }
    let additions: Vec<usize> = spare.into_iter().rev().collect();

    // What the package holds apart from the accounts being rewritten or taken
    // out: the lines kept, and every account the block did not open.
    let candidates: Vec<[u8; 32]> = pairs
        .iter()
        .map(|(_, f)| *f)
        .chain(additions.iter().copied())
        .map(|f| fingerprint(&key, LINE_PURPOSE, &identity_of(fresh[f])))
        .collect::<Result<_, _>>()?;
    let mut held: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    for (index, (_, line)) in opened.iter().enumerate() {
        if kept[index] {
            held.insert(fingerprint(&key, LINE_PURPOSE, &identity_of(line))?.to_vec());
        }
    }
    held.extend(
        sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT fingerprint FROM telegram_stock_accounts
             WHERE product_id = $1 AND fingerprint = ANY($2) AND NOT (id = ANY($3))",
        )
        .bind(product_id)
        .bind(candidates.iter().map(|c| c.to_vec()).collect::<Vec<_>>())
        .bind(&ids)
        .fetch_all(&mut *database)
        .await
        .map_err(database_error)?,
    );

    // A rewrite or an addition of a line the package already holds is left out;
    // a rewrite that is left out takes its account out, as the block no longer
    // has it.
    let mut duplicates = 0_i32;
    let mut rewrites: Vec<(Uuid, &String)> = Vec::new();
    let mut insertions: Vec<&String> = Vec::new();
    for (index, f) in &pairs {
        if held.insert(fingerprint(&key, LINE_PURPOSE, &identity_of(fresh[*f]))?.to_vec()) {
            rewrites.push((opened[*index].0, fresh[*f]));
        } else {
            duplicates += 1;
            removals.push(opened[*index].0);
        }
    }
    for f in &additions {
        if held.insert(fingerprint(&key, LINE_PURPOSE, &identity_of(fresh[*f]))?.to_vec()) {
            insertions.push(fresh[*f]);
        } else {
            duplicates += 1;
        }
    }

    let (changed, added, removed) = (
        rewrites.len() as i32,
        insertions.len() as i32,
        removals.len() as i32,
    );
    if !apply {
        return Ok(Edited {
            added,
            available: (available_now - removed + added).max(0),
            changed,
            duplicates,
            removed,
        });
    }

    if !removals.is_empty() {
        sqlx::query(
            "DELETE FROM telegram_stock_accounts WHERE id = ANY($1) AND order_reference IS NULL",
        )
        .bind(&removals)
        .execute(&mut *database)
        .await
        .map_err(database_error)?;
    }
    for (id, line) in &rewrites {
        let sealed = seal(&key, *id, line)?;
        sqlx::query(
            "UPDATE telegram_stock_accounts
             SET nonce = $2, ciphertext = $3, fingerprint = $4, email_fingerprint = $5
             WHERE id = $1 AND order_reference IS NULL",
        )
        .bind(id)
        .bind(sealed.nonce.as_slice())
        .bind(&sealed.ciphertext)
        .bind(fingerprint(&key, LINE_PURPOSE, &identity_of(line))?.as_slice())
        .bind(fingerprint(&key, EMAIL_PURPOSE, &email_of(line))?.as_slice())
        .execute(&mut *database)
        .await
        .map_err(database_error)?;
    }
    for line in &insertions {
        insert_account(&mut database, &key, product_id, line, actor.id).await?;
    }

    // Moved by what was taken out and put in, not recounted, as a sale does.
    let available = sqlx::query_scalar::<_, i32>(
        "UPDATE telegram_products
         SET available = GREATEST(available - $2 + $3, 0), updated_at = NOW()
         WHERE id = $1
         RETURNING available",
    )
    .bind(product_id)
    .bind(removed)
    .bind(added)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;
    if added != removed {
        record_change(
            &mut database,
            product_id,
            added - removed,
            available,
            actor.id,
        )
        .await?;
    }
    database.commit().await.map_err(database_error)?;

    Ok(Edited {
        added,
        available,
        changed,
        duplicates,
        removed,
    })
}

/// A paid order stops holding stock and starts using it up. For an ordinary
/// package that is the quantity ordered. For one that hands out accounts it is the
/// accounts actually given, oldest first, and the order is paid either way: when
/// fewer are left than were ordered (two buyers paid for the last one at once) the
/// order gets what there is and the buyer is told to write to the owner, who
/// settles the rest with them directly.
///
/// Accounts another sale is taking at that moment are skipped rather than waited
/// for, so two sales at once never take the same account and neither blocks the
/// other. The count is lowered by what was taken, not recounted: a recount would
/// miss a sale that has not committed yet.
pub(crate) async fn use_up_stock(
    database: &mut sqlx::PgConnection,
    item_id: &str,
    reference: &str,
    quantity: i32,
) -> Result<(), ApiError> {
    let product = sqlx::query_as::<_, (Uuid, bool)>(
        "SELECT id, delivers_accounts FROM telegram_products WHERE slug = $1",
    )
    .bind(item_id)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;
    // A product deleted since the order was made has nothing left to take from.
    let Some((product_id, delivers)) = product else {
        return Ok(());
    };

    let used = if delivers {
        take_accounts(database, product_id, reference, quantity).await?
    } else {
        quantity
    };

    // `GREATEST` covers a count lowered while the order was open.
    sqlx::query(
        "UPDATE telegram_products
         SET available = GREATEST(available - $2, 0), updated_at = NOW()
         WHERE id = $1",
    )
    .bind(product_id)
    .bind(used)
    .execute(&mut *database)
    .await
    .map_err(database_error)?;

    Ok(())
}

/// Hands the oldest accounts not yet sold to an order, and says how many it got:
/// fewer than `quantity` when fewer are left. Accounts another sale is taking
/// right now are skipped rather than waited for, so two sales at once never take
/// the same account and neither holds the other up.
pub(crate) async fn take_accounts(
    database: &mut sqlx::PgConnection,
    product_id: Uuid,
    reference: &str,
    quantity: i32,
) -> Result<i32, ApiError> {
    let taken = sqlx::query(
        "UPDATE telegram_stock_accounts
         SET order_reference = $2, sold_at = NOW()
         WHERE id IN (
             SELECT id FROM telegram_stock_accounts
             WHERE product_id = $1 AND order_reference IS NULL
             ORDER BY created_at, id
             LIMIT $3
             FOR UPDATE SKIP LOCKED
         )",
    )
    .bind(product_id)
    .bind(reference)
    .bind(i64::from(quantity))
    .execute(database)
    .await
    .map_err(database_error)?
    .rows_affected();

    i32::try_from(taken).map_err(|_| ApiError::Internal)
}

/// What a paid order was handed, for the bot to put in front of its buyer. Not
/// `Debug`: a derived `Debug` would print the accounts wherever it is logged.
#[derive(serde::Serialize)]
pub(crate) struct Delivery {
    pub accounts: Vec<String>,
    /// Ordered but not given, because none were left. Zero for a package that
    /// does not hand out accounts.
    pub missing: i32,
}

/// The accounts an order was handed, opened for its buyer. Only the buyer whose
/// order it is, and only once it is paid: anyone else, and any order that is not
/// paid, is `NotFound`. Safe to ask for again, which is how a buyer whose message
/// did not arrive gets the accounts back.
pub(crate) async fn delivery_for_order(
    state: &AppState,
    telegram_user_id: i64,
    reference: &str,
) -> Result<Delivery, ApiError> {
    let (item_id, quantity) = sqlx::query_as::<_, (String, i32)>(
        "SELECT item_id, quantity FROM telegram_orders
         WHERE reference = $1 AND telegram_user_id = $2 AND status = 'paid'",
    )
    .bind(reference)
    .bind(telegram_user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    let delivers = sqlx::query_scalar::<_, bool>(
        "SELECT delivers_accounts FROM telegram_products WHERE slug = $1",
    )
    .bind(&item_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .unwrap_or(false);
    if !delivers {
        return Ok(Delivery {
            accounts: Vec::new(),
            missing: 0,
        });
    }

    let key = state
        .config
        .stock_encryption_key
        .ok_or(ApiError::NotAvailable(NO_KEY))?;
    let rows = sqlx::query_as::<_, (Uuid, Vec<u8>, Vec<u8>)>(
        "SELECT id, nonce, ciphertext FROM telegram_stock_accounts
         WHERE order_reference = $1
         ORDER BY sold_at, id",
    )
    .bind(reference)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let accounts = rows
        .iter()
        .map(|(id, nonce, ciphertext)| open(&key, *id, nonce, ciphertext))
        .collect::<Result<Vec<_>, _>>()?;
    let given = i32::try_from(accounts.len()).map_err(|_| ApiError::Internal)?;

    Ok(Delivery {
        accounts,
        missing: (quantity - given).max(0),
    })
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("telegram stock accounts", error)
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{
        EMAIL_PURPOSE, LINE_PURPOSE, email_of, fingerprint, identity_of, mask_email, open,
        parse_accounts, seal,
    };
    use crate::core::ApiError;

    const KEY: [u8; 32] = [3; 32];

    #[test]
    fn a_sealed_account_opens_for_its_own_row_and_for_no_other() {
        let id = Uuid::new_v4();
        let sealed = seal(&KEY, id, "someone@example.test|pa55word").unwrap();

        assert_eq!(
            open(&KEY, id, &sealed.nonce, &sealed.ciphertext).unwrap(),
            "someone@example.test|pa55word"
        );
        // The same bytes under another row's id, under another key, or altered.
        assert!(open(&KEY, Uuid::new_v4(), &sealed.nonce, &sealed.ciphertext).is_err());
        assert!(open(&[4; 32], id, &sealed.nonce, &sealed.ciphertext).is_err());
        let mut altered = sealed.ciphertext.clone();
        altered[0] ^= 1;
        assert!(open(&KEY, id, &sealed.nonce, &altered).is_err());
    }

    #[test]
    fn what_is_stored_shows_nothing_of_the_account() {
        let sealed = seal(&KEY, Uuid::new_v4(), "someone@example.test|pa55word").unwrap();
        let stored = [sealed.nonce.as_slice(), sealed.ciphertext.as_slice()].concat();

        for needle in ["someone", "example", "pa55word"] {
            assert!(
                !stored
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes()),
                "{needle}"
            );
        }
    }

    #[test]
    fn two_seals_of_the_same_line_differ() {
        let id = Uuid::new_v4();
        let first = seal(&KEY, id, "a@example.test|x").unwrap();
        let second = seal(&KEY, id, "a@example.test|x").unwrap();

        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.ciphertext, second.ciphertext);
    }

    #[test]
    fn a_fingerprint_follows_the_text_the_key_and_the_purpose_and_is_not_the_text() {
        let line = "a@example.test|x";
        let of = |key: &[u8; 32], purpose, text| fingerprint(key, purpose, text).unwrap();

        assert_eq!(of(&KEY, LINE_PURPOSE, line), of(&KEY, LINE_PURPOSE, line));
        assert_ne!(
            of(&KEY, LINE_PURPOSE, line),
            of(&KEY, LINE_PURPOSE, "b@example.test|x")
        );
        assert_ne!(
            of(&KEY, LINE_PURPOSE, line),
            of(&[4; 32], LINE_PURPOSE, line)
        );
        // The same text hashed for two purposes gives two different answers.
        assert_ne!(of(&KEY, LINE_PURPOSE, line), of(&KEY, EMAIL_PURPOSE, line));
    }

    #[test]
    fn an_email_is_found_the_same_way_however_it_was_typed() {
        assert_eq!(
            email_of("Someone@Example.TEST|pa55"),
            "someone@example.test"
        );
        assert_eq!(
            email_of("someone@example.test|other|bar"),
            "someone@example.test"
        );
    }

    #[test]
    fn two_lines_are_the_same_account_when_only_the_case_of_the_email_differs() {
        assert_eq!(
            identity_of("Someone@Example.TEST|Pa55"),
            identity_of("someone@example.test|Pa55")
        );
        // The password is exact.
        assert_ne!(
            identity_of("someone@example.test|Pa55"),
            identity_of("someone@example.test|pa55")
        );
    }

    #[test]
    fn an_email_is_hidden_but_for_its_first_letter_and_its_domain() {
        assert_eq!(
            mask_email("someone@example.test|pa55word"),
            "s***@example.test"
        );
        assert_eq!(mask_email("plainlogin|pa55word"), "p***");
        // Nothing of the password is in a hint.
        assert!(!mask_email("someone@example.test|pa55word").contains("pa55"));
    }

    #[test]
    fn a_pasted_block_is_read_line_by_line() {
        let accounts = parse_accounts(
            "  one@example.test | pass one \n\n two@example.test|p|ipe\r\n   \nthree@example.test|x",
        )
        .unwrap();

        // Spaces around the bar go, and a bar inside the password stays.
        assert_eq!(
            accounts,
            [
                "one@example.test|pass one",
                "two@example.test|p|ipe",
                "three@example.test|x"
            ]
        );
    }

    #[test]
    fn a_line_that_is_not_an_email_and_a_password_is_refused_without_quoting_it() {
        for block in [
            "",
            "   \n \n",
            "no-bar-here",
            "|password",
            "email@example.test|",
            "email@example.test|   ",
            "email@example.test|pass\tword",
            &format!("a@example.test|{}", "x".repeat(300)),
            &"a@example.test|x\n".repeat(1001),
        ] {
            let Err(ApiError::Validation(message)) = parse_accounts(block) else {
                panic!(
                    "{:?} should be refused",
                    block.chars().take(20).collect::<String>()
                );
            };

            assert!(!message.contains("example"), "{message}");
        }

        // The limits themselves are allowed.
        assert!(parse_accounts(&format!("a@b|{}", "x".repeat(296))).is_ok());
        let thousand: Vec<String> = (0..1000).map(|n| format!("a{n}@example.test|x")).collect();
        assert_eq!(parse_accounts(&thousand.join("\n")).unwrap().len(), 1000);
    }
}

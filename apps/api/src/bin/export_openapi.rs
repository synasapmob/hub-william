use std::{env, fs};

use hub_william_backend::ApiDoc;
use utoipa::OpenApi;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output_path = env::args().nth(1).ok_or("expected an output path")?;
    let document = ApiDoc::openapi().to_pretty_json()?;

    fs::write(output_path, document)?;

    Ok(())
}

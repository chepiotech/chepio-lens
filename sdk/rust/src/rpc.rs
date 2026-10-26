// Core
use axum::http::{HeaderMap, Uri};
use opentelemetry::KeyValue;
// Domain
use chepio_lens_conventions::grpc;
// Consts
use chepio_lens_conventions::keys::{RPC_METHOD, RPC_METHOD_ORIGINAL, RPC_SYSTEM_NAME};

pub(crate) fn is_grpc(headers: &HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|value| {
            let mime = value.split(';').next().unwrap_or_default().trim();
            mime.eq_ignore_ascii_case("application/grpc")
                || mime
                    .get(..17)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("application/grpc+"))
        })
}

pub(crate) fn attributes(uri: &Uri, methods: &[&str]) -> (String, Vec<KeyValue>) {
    let original = grpc::method(uri.path());
    let method = original
        .filter(|method| methods.contains(method))
        .unwrap_or("_OTHER");
    let mut attributes = vec![
        KeyValue::new(RPC_SYSTEM_NAME, "grpc"),
        KeyValue::new(RPC_METHOD, method.to_owned()),
    ];
    if method == "_OTHER"
        && let Some(original) = original
    {
        attributes.push(KeyValue::new(RPC_METHOD_ORIGINAL, original.to_owned()));
    }
    (
        if method == "_OTHER" { "grpc" } else { method }.to_owned(),
        attributes,
    )
}

fn main() {
    println!("demo-api {}", env!("CARGO_PKG_VERSION"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_name_is_demo_api() {
        assert_eq!(env!("CARGO_PKG_NAME"), "demo-api");
    }
}

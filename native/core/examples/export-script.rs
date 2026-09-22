fn main() {
    let engine = pake_blocker_core::Blocker::from_bundle(&pake_blocker_core::baseline()).unwrap();
    print!("{}", engine.document_script());
}

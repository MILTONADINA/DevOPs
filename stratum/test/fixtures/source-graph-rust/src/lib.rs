// fn ghost() {}
/* nested /* fn hidden() {} */ mod absent; */
const TEXT: &str = r##"fn fake() {} mod absent;"##;
mod helper;

pub fn entry() {
    let text = "fn string_decoy() {}";
    fn nested() {}
    let _ = text;
}

use serde_json::json;
use std::env;
use std::io::{self, BufReader, Read, Write};
use std::path::PathBuf;
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;

fn emit(value: serde_json::Value) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model_path = env::args()
        .nth(1)
        .ok_or("usage: meeting-notes-parakeet-worker MODEL_DIRECTORY")?;
    let mut model = ParakeetModel::load(&PathBuf::from(model_path), &Quantization::Int8)?;
    emit(json!({ "ready": true }))?;

    let stdin = io::stdin();
    let mut input = BufReader::new(stdin.lock());

    loop {
        let mut header = [0_u8; 8];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        }

        // The top bit of the id asks for each word's timing too (for editing a recording by its transcript).
        let raw_id = u32::from_le_bytes(header[0..4].try_into()?);
        let with_words = raw_id & 0x8000_0000 != 0;
        let request_id = raw_id & 0x7fff_ffff;
        let sample_count = u32::from_le_bytes(header[4..8].try_into()?) as usize;
        if sample_count == 0 || sample_count > 16_000 * 30 {
            emit(json!({ "id": request_id, "error": "invalid PCM segment length" }))?;
            continue;
        }

        let mut bytes = vec![0_u8; sample_count * 4];
        input.read_exact(&mut bytes)?;
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four-byte float")))
            .collect();

        let params = ParakeetParams {
            timestamp_granularity: if with_words { Some(TimestampGranularity::Word) } else { None },
            ..ParakeetParams::default()
        };
        match model.transcribe_with(&samples, &params) {
            Ok(result) if with_words => {
                let words: Vec<serde_json::Value> = result
                    .segments
                    .unwrap_or_default()
                    .iter()
                    .map(|word| json!({ "text": word.text.trim(), "start": word.start, "end": word.end }))
                    .collect();
                emit(json!({ "id": request_id, "text": result.text.trim(), "words": words }))?
            }
            Ok(result) => emit(json!({ "id": request_id, "text": result.text.trim() }))?,
            Err(error) => emit(json!({ "id": request_id, "error": error.to_string() }))?,
        }
    }

    Ok(())
}

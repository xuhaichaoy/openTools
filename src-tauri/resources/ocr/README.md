# OCR Models

Place OCR ONNX model files in this directory when developing locally:

- `ppocr_det.onnx`
- `ppocr_rec.onnx` (or other `ppocr_rec*.onnx`, recommended `PP-OCRv5`)
- `ppocr_keys_v5.txt` (recommended character dictionary; `ppocr_keys_v1.txt` still compatible for old models)
- `ppocr_cls.onnx` (optional)
- `libonnxruntime.dylib` (macOS, required when using dynamic ORT loading)

At runtime, the app also checks the writable user data directory:

- `<app_data_dir>/models/ppocr`

You can open that directory from the OCR plugin UI.

## macOS runtime quick fix

If OCR reports `libonnxruntime.dylib` missing:

1. Install runtime:
   - `brew install onnxruntime`
2. Reopen OCR and click `重新检测`.

If still missing, copy the dylib into your model directory:

- Apple Silicon: `cp /opt/homebrew/lib/libonnxruntime.dylib "$HOME/Library/Application Support/com.51cto.toolbox/models/ppocr/"`
- Intel: `cp /usr/local/lib/libonnxruntime.dylib "$HOME/Library/Application Support/com.51cto.toolbox/models/ppocr/"`

Optional override:

- set env `ORT_DYLIB_PATH` to a dylib file path or directory path.

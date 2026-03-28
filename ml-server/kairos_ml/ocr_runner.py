_reader = None


def _get_reader():
    global _reader
    if _reader is not None:
        return _reader

    try:
        from paddleocr import PaddleOCR
        _reader = PaddleOCR(use_angle_cls=True, lang="ch")
        _reader.__class__._backend = "paddle"
        return _reader
    except ImportError:
        pass

    try:
        import easyocr
        _reader = easyocr.Reader(["ch_sim", "en"])
        _reader.__class__._backend = "easy"
        return _reader
    except ImportError:
        pass

    raise RuntimeError("No OCR backend available. Install paddleocr or easyocr.")


def run_ocr(image_path: str) -> list[dict]:
    reader = _get_reader()
    backend = getattr(reader.__class__, "_backend", "unknown")

    if backend == "paddle":
        result = reader.ocr(image_path, cls=True)
        texts = []
        for line in (result[0] or []):
            bbox_raw, (text, conf) = line
            texts.append({
                "text": text,
                "confidence": float(conf),
                "bbox": [
                    int(bbox_raw[0][0]), int(bbox_raw[0][1]),
                    int(bbox_raw[2][0]), int(bbox_raw[2][1]),
                ],
            })
        return texts

    # easyocr
    result = reader.readtext(image_path)
    return [
        {
            "text": text,
            "confidence": float(conf),
            "bbox": [
                int(bbox[0][0]), int(bbox[0][1]),
                int(bbox[2][0]), int(bbox[2][1]),
            ],
        }
        for bbox, text, conf in result
    ]

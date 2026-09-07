"""Instant comic-style filter — classical image processing, no model, runs anywhere."""
import cv2, numpy as np

def comic(bgr, quant=7, edge_strength=1.0, sat=1.55, smooth=2, palette=0.35):
    img = bgr.copy()
    # 1. edge-preserving smoothing: flattens skin and background, keeps boundaries
    for _ in range(smooth):
        img = cv2.bilateralFilter(img, 9, 90, 90)

    # 2. posterise in LAB so quantisation follows perceived colour, not RGB
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    Z = lab.reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
    _, lbl, cen = cv2.kmeans(Z, quant, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    flat = cen[lbl.flatten()].reshape(lab.shape).astype(np.uint8)
    flat = cv2.cvtColor(flat, cv2.COLOR_LAB2BGR)

    # 3. lift saturation, and push the palette toward comic-print primaries
    hsv = cv2.cvtColor(flat, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * sat, 0, 255)
    hsv[..., 2] = np.clip((hsv[..., 2] - 128) * 1.12 + 128, 0, 255)
    flat = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    if palette:
        tint = np.zeros_like(flat, np.float32)
        tint[..., 0] = 255; tint[..., 2] = 120          # cyan / magenta bias
        lum = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        shade = (1 - lum)[..., None] * palette
        flat = np.clip(flat * (1 - shade) + tint * shade, 0, 255).astype(np.uint8)

    # 4. ink lines from a blurred grey, so noise doesn't become hatching
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    grey = cv2.medianBlur(grey, 5)
    edges = cv2.adaptiveThreshold(grey, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                  cv2.THRESH_BINARY, 9, 6)
    if edge_strength != 1.0:
        k = max(1, int(round(edge_strength)))
        edges = cv2.erode(edges, np.ones((k, k), np.uint8))
    ink = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
    return cv2.bitwise_and(flat, ink)

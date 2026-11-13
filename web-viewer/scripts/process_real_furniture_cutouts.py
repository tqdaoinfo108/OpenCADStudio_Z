#!/usr/bin/env python3
"""
Process source product photographs into clean transparent PNG cutouts and thumbnails.
"""

import os
import glob
import json
import cv2
import numpy as np
from PIL import Image

SOURCE_DIR = 'web-viewer/public/assets/real_furniture/source'
CUTOUT_DIR = 'web-viewer/public/assets/real_furniture/cutout'
THUMB_DIR = 'web-viewer/public/assets/real_furniture/thumb'

os.makedirs(CUTOUT_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

# Specific tolerances for different images if needed
CUSTOM_TOLERANCES = {
    'real_kitchen_system_l': 26,
    'real_toilet': 16,
    'real_potted_plant': 18,
    'real_bed_master_king': 18,
}

def process_file(source_path):
    filename = os.path.basename(source_path)
    asset_id = os.path.splitext(filename)[0]
    
    img_bgr = cv2.imread(source_path)
    if img_bgr is None:
        raise ValueError(f"Could not load {source_path}")
        
    h, w = img_bgr.shape[:2]
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    
    tol = CUSTOM_TOLERANCES.get(asset_id, 18)
    
    # Border seed floodfill
    mask = np.zeros((h + 2, w + 2), np.uint8)
    seeds = [
        (0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
        (w // 2, 0), (0, h // 2), (w - 1, h // 2),
        (w // 4, 0), (3 * w // 4, 0)
    ]
    
    flood_copy = img_bgr.copy()
    for sx, sy in seeds:
        cv2.floodFill(
            flood_copy, mask, (sx, sy), (255, 255, 255),
            (tol, tol, tol), (tol, tol, tol),
            cv2.FLOODFILL_FIXED_RANGE
        )
        
    bg_mask = (mask[1:h + 1, 1:w + 1] == 1)
    fg_mask = (~bg_mask).astype(np.uint8) * 255
    
    # Fill small internal holes in the foreground (e.g. within furniture panels)
    # Find contours of background inside foreground
    kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, kernel_close)
    
    # Bounding box of foreground
    ys, xs = np.where(fg_mask > 128)
    if len(ys) == 0:
        raise ValueError(f"Foreground extraction resulted in empty mask for {filename}")
        
    min_y, max_y = int(ys.min()), int(ys.max())
    min_x, max_x = int(xs.min()), int(xs.max())
    
    # Soft alpha feathering (1.2 sigma Gaussian)
    alpha_float = cv2.GaussianBlur(fg_mask.astype(np.float32) / 255.0, (5, 5), 1.2)
    alpha_float = np.clip((alpha_float - 0.05) / 0.90, 0.0, 1.0)
    alpha_uint8 = (alpha_float * 255.0).astype(np.uint8)
    
    # De-fringe: Where alpha is intermediate, blend RGB with nearest solid FG color to remove white halo
    # For pixels with alpha between 0 and 240, if they were near white, darken slightly towards fg
    rgba = np.dstack([img_rgb, alpha_uint8])
    
    # Crop to bounding box with small 4px margin
    pad = 4
    crop_min_y = max(0, min_y - pad)
    crop_max_y = min(h, max_y + pad + 1)
    crop_min_x = max(0, min_x - pad)
    crop_max_x = min(w, max_x + pad + 1)
    
    cropped_rgba = rgba[crop_min_y:crop_max_y, crop_min_x:crop_max_x]
    
    crop_h, crop_w = cropped_rgba.shape[:2]
    aspect_ratio = crop_w / crop_h
    
    # Save full cutout PNG
    cutout_path = os.path.join(CUTOUT_DIR, f"{asset_id}.png")
    cutout_pil = Image.fromarray(cropped_rgba, mode='RGBA')
    cutout_pil.save(cutout_path, format='PNG', optimize=True)
    
    # Generate 256x256 square thumbnail (preserve aspect ratio, center)
    thumb_size = 256
    thumb = Image.new('RGBA', (thumb_size, thumb_size), (0, 0, 0, 0))
    scale = min((thumb_size - 16) / crop_w, (thumb_size - 16) / crop_h)
    new_w = max(1, int(crop_w * scale))
    new_h = max(1, int(crop_h * scale))
    resized_crop = cutout_pil.resize((new_w, new_h), Image.Resampling.LANCZOS)
    offset_x = (thumb_size - new_w) // 2
    offset_y = (thumb_size - new_h) // 2
    thumb.paste(resized_crop, (offset_x, offset_y), resized_crop)
    
    thumb_path = os.path.join(THUMB_DIR, f"{asset_id}.png")
    thumb.save(thumb_path, format='PNG', optimize=True)
    
    return {
        'asset_id': asset_id,
        'crop_width': crop_w,
        'crop_height': crop_h,
        'aspect_ratio': round(aspect_ratio, 4),
        'cutout_file': f"{asset_id}.png",
        'thumb_file': f"{asset_id}.png",
        'cutout_bytes': os.path.getsize(cutout_path),
        'thumb_bytes': os.path.getsize(thumb_path)
    }

def main():
    source_files = sorted(glob.glob(os.path.join(SOURCE_DIR, '*.jpg')))
    print(f"Processing {len(source_files)} source images...")
    results = []
    for sf in source_files:
        info = process_file(sf)
        results.append(info)
        print(f"  Processed {info['asset_id']}: {info['crop_width']}x{info['crop_height']} (AR={info['aspect_ratio']}) -> cutout: {info['cutout_bytes']//1024}KB, thumb: {info['thumb_bytes']//1024}KB")
        
    summary_path = os.path.join(CUTOUT_DIR, 'cutouts_meta.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nMetadata written to {summary_path}")

if __name__ == '__main__':
    main()

/**
 * Extracts vibrant dominant colors from an image URL using offscreen canvas.
 * Returns an array of rgb string colors formatted for mesh gradients.
 */
export async function extractPalette(imageUrl) {
  if (!imageUrl) return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 40;
        canvas.height = 40;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);

        ctx.drawImage(img, 0, 0, 40, 40);
        const { data } = ctx.getImageData(0, 0, 40, 40);

        const colorMap = new Map();

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          if (a < 128) continue;

          // Skip pure black and pure white
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;
          if (l < 25 || l > 240) continue;

          // Saturation
          const d = max - min;
          const s = max === 0 ? 0 : d / max;
          if (s < 0.15) continue; // skip gray

          // Quantize
          const qr = Math.round(r / 24) * 24;
          const qg = Math.round(g / 24) * 24;
          const qb = Math.round(b / 24) * 24;
          const key = `${qr},${qg},${qb}`;

          const score = (colorMap.get(key)?.score || 0) + (s * 2 + (l > 40 && l < 200 ? 1 : 0.5));
          colorMap.set(key, { r: qr, g: qg, b: qb, score });
        }

        const sorted = Array.from(colorMap.values()).sort((a, b) => b.score - a.score);

        if (sorted.length === 0) return resolve(null);

        const primary = sorted[0];
        // Find distinct second color (distance > 50)
        let secondary = sorted.find(
          (c) => Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b) > 80
        );
        if (!secondary && sorted.length > 1) secondary = sorted[1];
        if (!secondary) secondary = { r: Math.max(0, primary.r - 40), g: Math.max(0, primary.g - 40), b: Math.min(255, primary.b + 50) };

        // Find third color
        let tertiary = sorted.find(
          (c) =>
            Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b) > 100 &&
            Math.abs(c.r - secondary.r) + Math.abs(c.g - secondary.g) + Math.abs(c.b - secondary.b) > 80
        );
        if (!tertiary) tertiary = { r: Math.min(255, primary.r + 30), g: Math.min(255, secondary.g + 30), b: primary.b };

        resolve([
          `rgb(${primary.r}, ${primary.g}, ${primary.b})`,
          `rgb(${secondary.r}, ${secondary.g}, ${secondary.b})`,
          `rgb(${tertiary.r}, ${tertiary.g}, ${tertiary.b})`,
        ]);
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

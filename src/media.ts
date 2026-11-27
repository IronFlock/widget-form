// Helpers of the media (photo) field: what a photo says about itself (its
// EXIF capture time and GPS position), resizing it into a JPEG, and the
// device's position. No Lit, no state: widget-form.ts calls them.

/** A position in decimal degrees, the altitude in metres above sea level. */
export type Position = { latitude: number; longitude: number; altitude: number | null }

/** What a photo's EXIF data tells; each part only when the photo carries it. */
export type PhotoFacts = { capturedAt?: Date; position?: Position }

// Bytes per component of each TIFF field type (BYTE, ASCII, SHORT, LONG,
// RATIONAL, UNDEFINED, SLONG, SRATIONAL).
const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

// Where in a JPEG the EXIF block sits: the APP1 segment comes right after the
// start marker, ahead of the image data, so the head of the file is enough.
const EXIF_HEAD_BYTES = 256 * 1024

/**
 * The capture time and GPS position a photo's EXIF data holds. Only JPEG is
 * read: the browser hands a phone photo over as one (iOS converts HEIC for a
 * web page), and anything else, or a broken block, gives nothing.
 */
export async function readPhotoFacts(file: Blob): Promise<PhotoFacts> {
    try {
        const head = await file.slice(0, EXIF_HEAD_BYTES).arrayBuffer()
        return parseJpegExif(new DataView(head))
    } catch {
        return {}
    }
}

/** The EXIF facts of a JPEG's head, or nothing; never throws. */
export function parseJpegExif(view: DataView): PhotoFacts {
    try {
        if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {}
        let at = 2
        while (at + 4 <= view.byteLength) {
            if (view.getUint8(at) !== 0xff) return {}
            const marker = view.getUint8(at + 1)
            // Fill bytes before a marker.
            if (marker === 0xff) {
                at++
                continue
            }
            // Start of the image data, or its end: no EXIF block before it.
            if (marker === 0xda || marker === 0xd9) return {}
            // Markers without a length.
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                at += 2
                continue
            }
            const length = view.getUint16(at + 2)
            if (length < 2) return {}
            // APP1 starting with "Exif\0\0", then a TIFF structure.
            if (
                marker === 0xe1 &&
                length >= 16 &&
                view.getUint32(at + 4) === 0x45786966 &&
                view.getUint16(at + 8) === 0
            ) {
                const facts = parseTiff(view, at + 10, Math.min(at + 2 + length, view.byteLength))
                if (facts) return facts
            }
            at += 2 + length
        }
    } catch {
        // A block that points outside the bytes read: nothing usable.
    }
    return {}
}

type Entry = { type: number; count: number; at: number }

function parseTiff(view: DataView, start: number, end: number): PhotoFacts | undefined {
    const order = view.getUint16(start)
    const little = order === 0x4949 ? true : order === 0x4d4d ? false : undefined
    if (little === undefined || view.getUint16(start + 2, little) !== 42) return undefined

    const inside = (offset: number, size: number) => offset >= start && offset + size <= end

    // The entries of the IFD at a TIFF offset, by tag; a value of up to four
    // bytes sits in the entry itself, a longer one at the offset it names.
    const ifd = (offset: number): Map<number, Entry> => {
        const entries = new Map<number, Entry>()
        const base = start + offset
        if (!offset || !inside(base, 2)) return entries
        const count = view.getUint16(base, little)
        for (let k = 0; k < count; k++) {
            const e = base + 2 + k * 12
            if (!inside(e, 12)) break
            const type = view.getUint16(e + 2, little)
            const n = view.getUint32(e + 4, little)
            const size = (TYPE_SIZES[type] ?? 0) * n
            if (!size) continue
            const at = size <= 4 ? e + 8 : start + view.getUint32(e + 8, little)
            if (inside(at, size)) entries.set(view.getUint16(e, little), { type, count: n, at })
        }
        return entries
    }

    const long = (entry?: Entry) =>
        entry && (entry.type === 4 || entry.type === 3)
            ? entry.type === 4
                ? view.getUint32(entry.at, little)
                : view.getUint16(entry.at, little)
            : 0
    const text = (entry?: Entry) => {
        if (!entry || entry.type !== 2) return ''
        let out = ''
        for (let k = 0; k < entry.count; k++) {
            const code = view.getUint8(entry.at + k)
            if (!code) break
            out += String.fromCharCode(code)
        }
        return out.trim()
    }
    const rational = (entry: Entry | undefined, index: number): number => {
        if (!entry || (entry.type !== 5 && entry.type !== 10) || index >= entry.count) return NaN
        const at = entry.at + index * 8
        const signed = entry.type === 10
        const numerator = signed ? view.getInt32(at, little) : view.getUint32(at, little)
        const denominator = signed ? view.getInt32(at + 4, little) : view.getUint32(at + 4, little)
        return denominator ? numerator / denominator : NaN
    }

    const ifd0 = ifd(view.getUint32(start + 4, little))
    const exif = ifd(long(ifd0.get(0x8769)))
    const gps = ifd(long(ifd0.get(0x8825)))

    const facts: PhotoFacts = {}
    const capturedAt = exifDate(text(exif.get(0x9003)), text(exif.get(0x9011)))
    if (capturedAt) facts.capturedAt = capturedAt

    const degrees = (entry?: Entry) =>
        rational(entry, 0) + rational(entry, 1) / 60 + rational(entry, 2) / 3600
    const latitude = degrees(gps.get(2)) * (text(gps.get(1)).toUpperCase() === 'S' ? -1 : 1)
    const longitude = degrees(gps.get(4)) * (text(gps.get(3)).toUpperCase() === 'W' ? -1 : 1)
    // 0/0 is what a camera without a fix writes, not a place anyone stands.
    if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180 &&
        (latitude !== 0 || longitude !== 0)
    ) {
        const altitudeRef = gps.get(5)
        const below = altitudeRef && altitudeRef.type === 1 && view.getUint8(altitudeRef.at) === 1
        const altitude = rational(gps.get(6), 0)
        facts.position = {
            latitude,
            longitude,
            altitude: Number.isFinite(altitude) ? (below ? -altitude : altitude) : null
        }
    }
    return facts
}

// EXIF's "YYYY:MM:DD HH:MM:SS", in the camera's local time unless an offset
// ("+02:00") came with it. Without one it is read as the viewer's local time,
// which is the camera's for a photo taken where it is uploaded.
function exifDate(value: string, offset: string): Date | undefined {
    const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value)
    if (!match) return undefined
    const [y, mo, d, h, mi, s] = match.slice(1).map(Number)
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined
    const zone = /^([+-])(\d{2}):(\d{2})$/.exec(offset)
    const date = zone
        ? new Date(
              Date.UTC(y, mo - 1, d, h, mi, s) -
                  (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000
          )
        : new Date(y, mo - 1, d, h, mi, s)
    return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * The photo as a JPEG whose longer edge is at most maxEdge pixels (never
 * enlarged), turned upright and without any EXIF data, or undefined when this
 * browser cannot decode it (HEIC outside Safari). Decoded through an <img>,
 * which applies the EXIF orientation in every current browser, and drawn
 * onto a canvas of the target size only. Transparency becomes white.
 */
export async function toJpeg(file: Blob, maxEdge: number, quality: number): Promise<Blob | undefined> {
    const url = URL.createObjectURL(file)
    try {
        const image = new Image()
        image.decoding = 'async'
        image.src = url
        await image.decode()
        const { naturalWidth: w, naturalHeight: h } = image
        if (!w || !h) return undefined
        const scale = Math.min(1, maxEdge / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const context = canvas.getContext('2d')
        if (!context) return undefined
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', quality)
        )
        // iOS keeps a canvas' memory until it is shrunk.
        canvas.width = canvas.height = 0
        return blob ?? undefined
    } catch {
        return undefined
    } finally {
        URL.revokeObjectURL(url)
    }
}

/**
 * The device's current position, or undefined when the browser has none to
 * give: the viewer refused, it took longer than timeoutMs, or the page is not
 * a secure context (an appliance's board over plain http), where browsers
 * offer no geolocation at all. The browser asks the viewer the first time.
 */
export function devicePosition(timeoutMs = 15_000): Promise<Position | undefined> {
    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.geolocation)
        return Promise.resolve(undefined)
    return new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
            ({ coords }) =>
                resolve({
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    altitude: typeof coords.altitude === 'number' ? coords.altitude : null
                }),
            () => resolve(undefined),
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 }
        )
    )
}

/** The file name a photo is stored under once it is a JPEG. */
export const jpegName = (name: string): string => {
    const base = name.replace(/\.[^./]*$/, '').trim()
    return `${base || 'photo'}.jpg`
}

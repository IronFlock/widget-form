import { html, css, LitElement, PropertyValues, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { keyed } from 'lit/directives/keyed.js'
import { ifDefined } from 'lit/directives/if-defined.js'
import { property, state, customElement, query } from 'lit/decorators.js'
import { FormConfiguration } from './definition-schema.js'

import '@material/web/fab/fab.js'
import '@material/web/icon/icon.js'
import '@material/web/dialog/dialog.js'

import '@material/web/button/text-button.js'
import '@material/web/button/outlined-button.js'
import '@material/web/button/filled-button.js'
import '@material/web/textfield/outlined-text-field.js'
import '@material/web/checkbox/checkbox.js'
import '@material/web/select/outlined-select.js'
import '@material/web/select/select-option.js'
import '@material/web/iconbutton/icon-button.js'

import type { MdDialog } from '@material/web/dialog/dialog.js'

type Column = Exclude<FormConfiguration['formFields'], undefined>[number]
type Theme = {
    theme_name: string
    theme_object: any
}

// Where a value goes: one column of one app table, as the targetColumn picker
// stored it (the host checks it).
type TargetRef = {
    swarm_app_databackend_key?: unknown
    table_name?: unknown
    column_name?: unknown
}

// A column value, as data-submit carries it.
type ValueItem = TargetRef & { value: unknown }

// The md-outlined-text-field of a colour field, as its handlers use it.
type ColorTextField = HTMLElement & { value: string; setCustomValidity: (message: string) => void }

// A file for the host to store in the app's FleetFiles namespace before it
// writes the row; the column gets the stored object's key, and urlColumn, when
// the field names one, the object's permanent URL, which only the host can
// build. Only file-data-submit carries these.
type FileItem = TargetRef & { file: File; namespace: string; contentType: string; urlColumn?: TargetRef }

// The detail of file-data-submit. The host claims the event by calling
// waitUntil() synchronously, while the event is dispatched, with a promise
// that settles once the files are stored and the rows written, or rejects
// with an Error whose message the form shows. An older Studio does not know
// the event, so nobody claims it and nothing is written: a File in a plain
// data-submit would have been serialized as garbage into the column.
export type FileDataSubmitDetail = {
    items: (ValueItem | FileItem)[]
    waitUntil: (outcome: Promise<unknown>) => void
}

const FILE_DATA_SUBMIT = 'file-data-submit'

// MIB is how the Maximum File Size setting counts a megabyte.
const MIB = 1024 * 1024

// A MIME type as FleetFiles matches it: lowercase, no parameters, and a
// trailing /* as the only wildcard.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/

// Content types by file extension, for files the browser types loosely: an
// unknown extension gives File.type '', and Windows with Excel installed calls
// a CSV application/vnd.ms-excel. The picker's accept attribute also lists the
// extensions of the accepted types, so the system dialog offers those files.
const EXTENSION_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime'
}

const typeMatches = (pattern: string, type: string): boolean =>
    pattern === type || (pattern.endsWith('/*') && type.startsWith(pattern.slice(0, -1)) && type.length > pattern.length - 1)

const acceptedTypesCache = new Map<string, string[]>()

// The Accepted File Types setting as a list of MIME types. Entries that are
// not a MIME type are dropped with a warning: as an accept filter they would
// hide every file, and FleetFiles would match none of them either.
const acceptedTypes = (raw: unknown): string[] => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) return []
    const cached = acceptedTypesCache.get(text)
    if (cached) return cached
    const types: string[] = []
    for (const entry of text.split(',')) {
        const type = entry.trim().toLowerCase()
        if (!type) continue
        if (MIME_TYPE.test(type)) types.push(type)
        else
            console.warn(
                `widget-form: ignoring accepted file type "${entry.trim()}" — it is not a MIME type such as application/pdf or image/*.`
            )
    }
    acceptedTypesCache.set(text, types)
    return types
}

// The picker's accept attribute: the accepted types plus the extensions that
// stand for them.
const acceptAttribute = (types: string[]): string => {
    if (!types.length) return ''
    const extensions = Object.entries(EXTENSION_TYPES)
        .filter(([, type]) => types.some((pattern) => typeMatches(pattern, type)))
        .map(([extension]) => '.' + extension)
    return [...types, ...extensions].join(',')
}

// The content type to store a file under, or undefined when it is none of the
// accepted types. The browser's type comes first, then the one its extension
// stands for; with no accepted types the file goes in as whatever it is.
const fileContentType = (file: File, accepted: string[]): string | undefined => {
    const own = (file.type.split(';')[0] ?? '').trim().toLowerCase()
    const extension = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ''
    const candidates = [own, EXTENSION_TYPES[extension] ?? ''].filter(Boolean)
    if (!accepted.length) return candidates[0] ?? 'application/octet-stream'
    return candidates.find((type) => accepted.some((pattern) => typeMatches(pattern, type)))
}

// The Maximum File Size setting in bytes, or undefined when unset or not a
// positive number.
const maxFileBytes = (field: Column): number | undefined => {
    const mb = Number(field.maxFileSizeMB)
    return field.maxFileSizeMB != null && mb > 0 ? mb * MIB : undefined
}

// A size for people: bytes, KB or MB in the viewer's locale, counted in 1024s
// like the Maximum File Size setting.
const formatBytes = (bytes: number): string => {
    const [value, unit] =
        bytes >= MIB ? [bytes / MIB, 'MB'] : bytes >= 1024 ? [bytes / 1024, 'KB'] : [bytes, 'bytes']
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`
}

// The file name an object key ends in: the host stores a file under a key
// whose last segment is the file's own name.
const fileNameOfKey = (key: string): string => key.split('/').filter(Boolean).pop() ?? key

// A column a file field writes beside the key: name, size, type or URL.
const companionRef = (target: any): TargetRef | undefined =>
    target?.tablename && target?.column
        ? {
              swarm_app_databackend_key: target.swarm_app_databackend_key,
              table_name: target.tablename,
              column_name: target.column
          }
        : undefined

// The HTML `pattern` attribute is compiled with the RegExp `v` flag, which
// reserves these characters inside a character class: they have to be escaped
// even where the older `u` flag accepted them bare.
const V_RESERVED_IN_CLASS = new Set(['(', ')', '[', '{', '}', '/', '|'])

// Escape the characters a `v`-flag character class reserves but that were
// plainly meant literally, so a regex written against the older semantics —
// `^[a-zA-Z0-9 _-]+$` and friends — keeps working. A hyphen is left alone
// where it sits between two class atoms, because there it is a range operator.
const escapeForVFlag = (pattern: string): string => {
    let out = ''
    let inClass = false
    // Index of the first atom of the current class, i.e. past `[` and any `^`.
    let classContentStart = 0
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]
        if (char === '\\') {
            out += char + (pattern[i + 1] ?? '')
            i++
        } else if (!inClass) {
            if (char === '[') {
                inClass = true
                classContentStart = pattern[i + 1] === '^' ? i + 2 : i + 1
            }
            out += char
        } else if (char === ']') {
            inClass = false
            out += char
        } else if (char === '-') {
            const isRange = i > classContentStart && i < pattern.length - 1 && pattern[i + 1] !== ']'
            out += isRange ? char : '\\-'
        } else {
            out += V_RESERVED_IN_CLASS.has(char) ? '\\' + char : char
        }
    }
    return out
}

const compilesAsPattern = (pattern: string): boolean => {
    try {
        // Same shape the HTML spec compiles the `pattern` attribute with.
        new RegExp('^(?:' + pattern + ')$', 'v')
        return true
    } catch {
        return false
    }
}

const patternCache = new Map<string, string>()

// A regex the browser cannot compile makes the text field throw a SyntaxError
// on every validity read, which kills validation reporting and form submission
// for the whole form. Repair what can be repaired, and drop the rest so a
// mis-escaped config costs one field's validation instead of the form.
const browserSafePattern = (raw?: string | null): string => {
    const pattern = raw?.trim()
    if (!pattern) return ''
    const cached = patternCache.get(pattern)
    if (cached !== undefined) return cached

    let safe = ''
    if (compilesAsPattern(pattern)) {
        safe = pattern
    } else {
        const escaped = escapeForVFlag(pattern)
        if (compilesAsPattern(escaped)) {
            safe = escaped
        } else {
            console.warn(
                `widget-form: ignoring validation regex "${pattern}" — it is not a valid regular expression under the "v" flag the HTML pattern attribute uses.`
            )
        }
    }
    patternCache.set(pattern, safe)
    return safe
}

// A Form Dialog Size minimum: a number with an optional unit, no unit meaning
// px. Nothing else gets through, so a value can neither add a declaration nor
// open a comment that swallows the cap below; CSS.supports() is no substitute,
// as it passes '800px/*'. The schema's `pattern` on both settings spells the
// same grammar for the AI's validate_widget (lowercase units and ASCII
// whitespace only, as Python's re checks it), so change the two together.
const DIALOG_MIN_SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*(px|%|vw|vh|rem|em)?$/i

const dialogMinSizeCache = new Map<string, string>()

// Turn a designer's minimum dialog width or height into a declaration for
// md-dialog's style attribute, or '' to keep the default when it is unset. It is
// capped at the window less Material's 24px margins: a minimum beats every
// max-*, and a dialog pushed off the screen takes along its action bar, the only
// way out of a dialog that swallows Escape and backdrop clicks. showModal() puts
// the dialog in the top layer, so % is a share of the window.
const dialogMinSize = (dimension: 'width' | 'height', raw: unknown): string => {
    const value = String(raw ?? '').trim()
    if (!value) return ''
    const key = `${dimension}:${value}`
    const cached = dialogMinSizeCache.get(key)
    if (cached !== undefined) return cached

    let declaration = ''
    const match = DIALOG_MIN_SIZE.exec(value)
    if (match) {
        const length = match[1] + (match[2]?.toLowerCase() ?? 'px')
        declaration = `min-${dimension}: min(${length}, calc(100% - 48px))`
    } else {
        console.warn(
            `widget-form: ignoring Form Dialog Size minimum ${dimension} "${value}" — it is not a number with an optional unit (px, %, vw, vh, rem or em), such as 800px or 60%.`
        )
    }
    dialogMinSizeCache.set(key, declaration)
    return declaration
}

// md-dialog's host is display: contents and holds the size limits its native
// <dialog> inherits, so its style attribute replaces Material's 280x140px
// minimum outright and beats the .form rule whenever it is larger. With nothing
// configured it gets no style at all.
const dialogSizeStyle = (size: FormConfiguration['formDialogSize']) => {
    const declarations = [dialogMinSize('width', size?.minWidth), dialogMinSize('height', size?.minHeight)]
    return declarations.filter(Boolean).join('; ') || nothing
}

// The share of a row a field takes, as Width and Default Field Width name it.
// The form is a 12-column grid, and the w-<width> classes span 12, 9, 8, 6, 4
// and 3 of its columns.
const FIELD_WIDTHS = ['full', 'three-quarters', 'two-thirds', 'half', 'third', 'quarter'] as const
type FieldWidth = (typeof FIELD_WIDTHS)[number]

const isFieldWidth = (value: unknown): value is FieldWidth =>
    (FIELD_WIDTHS as readonly unknown[]).includes(value)

// The narrowest a field gets in a narrow form unless the Field Layout says
// otherwise. A date and time and a select's value still show in full, and
// the default 480px dialog keeps two fields on a row: its fields get 415 to
// 432px, less its scrollbar, and two need 2 x 180 + 16.
const DEFAULT_MIN_FIELD_WIDTH = 180

// The gap between two fields on a row, in px: .form-content's column-gap, and
// the compact density's (:host([compact]) in the styles).
const FIELD_GAP = 16
const COMPACT_FIELD_GAP = 12

type FieldLayoutSettings = {
    defaultWidth: FieldWidth
    minFieldWidth: number
    compact: boolean
}

// The Field Layout with its defaults: unset or invalid, every field takes a
// full row at Material's standard size, the single column every form had
// before.
const fieldLayoutSettings = (layout: unknown): FieldLayoutSettings => {
    const settings = layout && typeof layout === 'object' ? (layout as Record<string, unknown>) : {}
    const raw = settings.minFieldWidth
    const min = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    return {
        defaultWidth: isFieldWidth(settings.defaultWidth) ? settings.defaultWidth : 'full',
        minFieldWidth: Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN_FIELD_WIDTH,
        compact: settings.density === 'compact'
    }
}

// A heading that groups the fields after it, rather than an input.
const isSection = (field: unknown): boolean => (field as Column | null | undefined)?.type === 'section'

// The index of the section whose group the entry at index i is in: the
// nearest section before it, if any. Sections do not nest.
const sectionOf = (fields: readonly unknown[], i: number): number | undefined => {
    for (let k = i - 1; k >= 0; k--) if (isSection(fields[k])) return k
    return undefined
}

// The width each formFields entry takes, by index: its own Width, else the
// Field Width in Group of the section it is in, else the form's Default
// Field Width. A section itself spans the row.
const fieldWidths = (fields: readonly unknown[], defaultWidth: FieldWidth): FieldWidth[] => {
    let groupWidth = defaultWidth
    return fields.map((entry) => {
        const field = entry as Column | null | undefined
        if (isSection(field)) {
            groupWidth = isFieldWidth(field?.groupWidth) ? field.groupWidth : defaultWidth
            return 'full'
        }
        return isFieldWidth(field?.width) ? field.width : groupWidth
    })
}

// The container queries that widen the fields of a form too narrow for them,
// so that none gets narrower than the minimum. A field spanning n of the 12
// columns is n/12 of the row less its share of the gaps, so a quarter reaches
// the minimum m at a form width of 4m + 3 gaps, a third at 3m + 2 gaps and a
// half at 2m + 1 gap. Three quarters and two thirds step down together with
// the quarter and the third they share a row with, so such a pair stays on
// one row: three quarters + a quarter become two thirds + a third, then two
// halves, then two full rows. Where several rules apply the later one wins
// (same specificity). 0 turns it off.
const collapseRules = (min: number, gap: number): string => {
    if (!(min > 0)) return ''
    const below = (fields: number) => fields * min + (fields - 1) * gap
    return `
        @container (width < ${below(4)}px) {
            .form-content > .w-quarter { grid-column-end: span 4; }
            .form-content > .w-three-quarters { grid-column-end: span 8; }
        }
        @container (width < ${below(3)}px) {
            .form-content > :is(.w-quarter, .w-third, .w-two-thirds, .w-three-quarters) {
                grid-column-end: span 6;
            }
        }
        @container (width < ${below(2)}px) {
            .form-content > :is(.w-quarter, .w-third, .w-half, .w-two-thirds, .w-three-quarters) {
                grid-column-end: span 12;
            }
        }
    `
}

let colorContext: CanvasRenderingContext2D | null | undefined

// A colour as [r, g, b, alpha] in sRGB (channels 0-255), parsed by the browser
// itself through a canvas's fillStyle, so names, hsl(), hex with alpha,
// color-mix() and the like all work; undefined when the browser rejects it.
// Only the normalised string is read, never pixels: with Firefox's
// resistFingerprinting on, as in Tor Browser, getImageData() answers with
// random colours.
const readColor = (value: string): number[] | undefined => {
    colorContext ??= document.createElement('canvas').getContext('2d')
    if (!colorContext) return undefined
    // Chromium hands oklch(), lab(), color() and the like back as written;
    // mixed into srgb they come back as color(srgb r g b / alpha). It rejects
    // light-dark() outright but takes it inside color-mix().
    for (const candidate of [value, `color-mix(in srgb, ${value} 100%, transparent)`]) {
        // A rejected value leaves the previous fillStyle in place, so set it
        // after two different placeholders: only an accepted one reads the same.
        colorContext.fillStyle = '#000'
        colorContext.fillStyle = candidate
        const color = String(colorContext.fillStyle)
        colorContext.fillStyle = '#fff'
        colorContext.fillStyle = candidate
        if (String(colorContext.fillStyle) !== color) continue
        let match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/.exec(color)
        if (match) return [...match.slice(1).map((hex) => parseInt(hex, 16)), 1]
        match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color)
        if (match) return match.slice(1).map(Number)
        match = /^color\(srgb (\S+) (\S+) (\S+)(?: \/ (\S+))?\)$/.exec(color)
        if (match) {
            const [r, g, b] = match.slice(1, 4).map((v) => Math.min(Math.max(Number(v) || 0, 0), 1) * 255)
            return [r, g, b, Number(match[4] ?? 1) || 0]
        }
    }
    return undefined
}

// A colour the browser rejects counts as fully transparent, the way an
// invalid background-color leaves a tile.
const parseColor = (value: string): number[] => readColor(value) ?? [0, 0, 0, 0]

const HEX_DIGITS = /^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i

/**
 * A colour field's value as it is stored: lowercase hex, #rrggbb, or
 * #rrggbbaa when it is translucent, so every widget and chart library can
 * read the column; undefined when it is no colour. Any CSS colour is taken,
 * and hex digits without the # too, as brand guides often print them.
 * currentColor and the CSS-wide keywords (inherit and the like) name no
 * colour of their own, so they count as none; the canvas rejects the
 * keywords, and CSS.supports() whatever only color-mix() would make a
 * colour of.
 */
const colorHex = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined
    const text = raw.trim()
    const value = HEX_DIGITS.test(text) ? '#' + text : text
    if (!value || /^currentcolor$/i.test(value) || !CSS.supports('color', value)) return undefined
    const color = readColor(value)
    if (!color) return undefined
    const hex = (channel: number) => Math.round(channel).toString(16).padStart(2, '0')
    const [r, g, b, alpha] = color
    return '#' + [r, g, b].map(hex).join('') + (alpha < 1 ? hex(alpha * 255) : '')
}

// What a colour field says when its text is no colour.
const COLOR_MESSAGE = 'Enter a color, such as #1e88e5, rgb(30, 136, 229) or teal.'

// A colour field's Pre-filled or Default Value key: its text, or undefined
// when it is blank or no text.
const colorKey = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined

const surfaceCache = new Map<string, string>()

// Paint the given colours, bottom first, over white, as the screen composites
// a translucent background over what is behind it, and return the opaque
// result as #rrggbb.
const opaqueSurface = (layers: string[]): string => {
    const key = JSON.stringify(layers)
    const cached = surfaceCache.get(key)
    if (cached !== undefined) return cached

    let surface = [255, 255, 255]
    for (const layer of layers) {
        const [r, g, b, alpha] = parseColor(layer)
        surface = [r, g, b].map((channel, i) => channel * alpha + surface[i] * (1 - alpha))
    }
    const hex = '#' + surface.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')
    surfaceCache.set(key, hex)
    return hex
}

// WCAG relative luminance of an opaque #rrggbb colour (0 black, 1 white).
const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const channel = parseInt(hex.slice(i, i + 2), 16) / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// A surface darker than mid grey (#777777 is about 0.18) counts as dark.
const DARK_SURFACE = 0.18

// How the dialog and the select menus are raised above a dark surface: white
// at this opacity over it. A dark page barely changes under the scrim, so a
// dialog in the tile's own colour would sink into it; Material 3 shows
// elevation in dark schemes by lightening a surface, not by a shadow, which
// does not show on a dark page either. A light surface needs no lift: the scrim
// already sets it apart.
const RAISE_ON_DARK = 'rgba(255, 255, 255, 0.16)'

const isDarkSurface = (surface: string): boolean => luminance(surface) < DARK_SURFACE

// The colour of what floats above a surface: the dialog and the select menus.
const raisedSurface = (surface: string): string =>
    isDarkSurface(surface) ? opaqueSurface([surface, RAISE_ON_DARK]) : surface

// Scrim opacity: Material's 32% black over a light dashboard; a dark one needs
// more to recede behind the dialog.
const SCRIM_OPACITY_LIGHT = 0.32
const SCRIM_OPACITY_DARK = 0.6

// Material 3's error colours for a light and a dark scheme.
const ERROR_ON_LIGHT = '#b3261e'
const ERROR_ON_DARK = '#f2b8b5'

// WCAG contrast ratio of two opaque #rrggbb colours, from 1 to 21.
const contrast = (a: string, b: string): number => {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (lighter + 0.05) / (darker + 0.05)
}

// Black or white, whichever contrasts more with an opaque #rrggbb colour.
const onColor = (opaque: string): string =>
    contrast(opaque, '#ffffff') >= contrast(opaque, '#000000') ? '#ffffff' : '#000000'

// WCAG's minimum contrast for a control's outline against its surroundings.
const ACCENT_CONTRAST = 3

/**
 * The highlight colour, Material's primary: the focused field's outline and
 * label, checked checkboxes and the Submit button. Material's own purple does
 * not read on every tile. A configured colour is taken as written; otherwise
 * the theme's first palette colour, when it stands out from the surface;
 * otherwise the text colour, which is picked to read on the tile. The colour
 * on it (Submit's label, the check mark) is black or white, whichever reads
 * better, and the surface itself on the text colour.
 */
const accentColors = (
    configured: unknown,
    themeColor: unknown,
    surface: string,
    textColor: string | undefined
): { primary: string; onPrimary: string } => {
    const candidates = [
        { color: configured, check: false },
        { color: themeColor, check: true }
    ]
    for (const { color, check } of candidates) {
        if (typeof color !== 'string' || !color.trim() || !(parseColor(color)[3] > 0)) continue
        const opaque = opaqueSurface([surface, color])
        if (check && contrast(opaque, surface) < ACCENT_CONTRAST) continue
        return { primary: color, onPrimary: onColor(opaque) }
    }
    return { primary: textColor || 'currentColor', onPrimary: surface }
}

// Size tokens of the regular form open button (Floating Action Button off):
// 32, 40 and 56px tall, as Material 3's extra small, small and medium
// buttons. Medium is Material Web's own 40px button and needs none.
const OPEN_BUTTON_SIZES: Record<string, string> = {
    small: `--md-filled-button-container-height: 32px; --md-filled-button-icon-size: 18px;
        --md-filled-button-label-text-size: 14px; --md-filled-button-label-text-line-height: 20px;
        --md-filled-button-with-leading-icon-leading-space: 12px;
        --md-filled-button-with-leading-icon-trailing-space: 16px;`,
    large: `--md-filled-button-container-height: 56px; --md-filled-button-icon-size: 24px;
        --md-filled-button-label-text-size: 16px; --md-filled-button-label-text-line-height: 24px;
        --md-filled-button-with-leading-icon-leading-space: 24px;
        --md-filled-button-with-leading-icon-trailing-space: 32px;`
}

// The trailing space of that button with an empty Label Text, by size: its
// leading space less the 8px gap Material keeps after the icon even with no
// label, which centres the icon.
const ICON_ONLY_TRAILING_SPACE: Record<string, string> = { small: '4px', medium: '8px', large: '16px' }

const BUTTON_SIZES = ['small', 'medium', 'large']

// A Form Open Button Style colour, or '' for the default. Every field but
// fab can be bound to a column, so the value is table data that lands in a
// style attribute: a ';' would add declarations and a '/*' swallow the ones
// after it (CSS.supports() passes a trailing comment).
const buttonColor = (value: unknown): string => {
    if (typeof value !== 'string') return ''
    const color = value.trim()
    return color && !/[;{}]|\/\*/.test(color) && CSS.supports('color', color) ? color : ''
}

// A Form Open Button Style corner radius as px, or '' for Material's own
// corners. A bound column may hold the number as text.
const buttonRadius = (value: unknown): string => {
    const radius = typeof value === 'string' && value.trim() ? Number(value) : value
    return typeof radius === 'number' && Number.isFinite(radius) && radius >= 0 ? `${radius}px` : ''
}

// Material sets the FAB's corners per size, so the radius goes to all three.
const FAB_SHAPE_SIZES = ['', 'small-', 'large-']

/**
 * Form Open Button Style with every field checked, since all but fab can be
 * bound and then carry whatever the column holds: a label may be a number, an
 * unknown size is medium, and a blank, non-string or invalid colour, corner
 * radius or icon name falls back to the default ('' for colours and the
 * radius, 'add' for the icon).
 */
const openButtonStyle = (style: FormConfiguration['formButtonStyle']) => {
    const { label, size, iconName } = style ?? {}
    const sizeName = typeof size === 'string' ? size.trim().toLowerCase() : ''
    return {
        fab: style?.fab !== false,
        label:
            typeof label === 'string'
                ? label.trim()
                : typeof label === 'number' && Number.isFinite(label)
                  ? String(label)
                  : '',
        size: BUTTON_SIZES.includes(sizeName) ? sizeName : 'medium',
        cornerRadius: buttonRadius(style?.cornerRadius),
        bgColor: buttonColor(style?.bgColor),
        color: buttonColor(style?.color),
        iconName: typeof iconName === 'string' && iconName.trim() ? iconName.trim() : 'add'
    }
}

let maskSheet: CSSStyleSheet | null | undefined

// The sheet that masks a secret field kept away from the browser's password
// manager: its plain text input is drawn as discs while the text field has
// the masked attribute, and its placeholder stays readable. Built on first
// use; null where the browser cannot construct style sheets.
const secretMaskSheet = (): CSSStyleSheet | null => {
    if (maskSheet === undefined) {
        try {
            maskSheet = new CSSStyleSheet()
            maskSheet.replaceSync(`
                :host([masked]) input {
                    -webkit-text-security: disc;
                }
                input::placeholder {
                    -webkit-text-security: none;
                }
            `)
        } catch {
            maskSheet = null
        }
    }
    return maskSheet
}

// What the input of a secret field kept away from the password manager also
// carries: no capitalising, correcting or spell-checking a value nobody sees
// (a phone would otherwise change a secret it cannot show), and the opt-outs
// of the common password manager extensions (1Password, LastPass, Bitwarden,
// Dashlane), which also look at text inputs.
const UNMANAGED_INPUT_ATTRIBUTES: [string, string][] = [
    ['autocapitalize', 'off'],
    ['autocorrect', 'off'],
    ['spellcheck', 'false'],
    ['data-1p-ignore', ''],
    ['data-lpignore', 'true'],
    ['data-bwignore', ''],
    ['data-form-type', 'other']
]

@customElement('widget-form-versionplaceholder')
export class WidgetForm extends LitElement {
    @property({ type: Object })
    inputData?: FormConfiguration

    @property({ type: Object })
    theme?: Theme

    @property({ type: String })
    route?: string

    @state() private themeBgColor?: string
    @state() private themeTitleColor?: string

    @state() dialogOpen: boolean = false

    @query('md-dialog') dialog!: MdDialog

    @state() private formKey = 0

    // Current value of every field, keyed by field label. Rebuilt on each
    // input/change so conditional-display rules (which reference a controlling
    // field by its label) re-evaluate live as the user fills the form.
    @state() private fieldValues: Record<string, string> = {}

    // The new file each file field holds, by field index, until it is saved
    // or the form is reset. Not uploaded yet: the host stores it on submit.
    @state() private chosenFiles: Record<number, File> = {}

    // Why a file field refused the file it was given, by field index.
    @state() private fileErrors: Record<number, string> = {}

    // The secret fields whose value is shown in clear text, by field index.
    @state() private revealedSecrets: Record<number, boolean> = {}

    // What each colour field holds since it was edited, by field index, for
    // its swatch, with the pre-filled value it replaced: a new pre-filled
    // value resets the text field, and then the swatch follows it again.
    @state() private typedColors: Record<number, { text: string; over: unknown }> = {}

    // The field index a file is being dragged over.
    @state() private dragTarget?: number

    // While the host uploads files and writes the row: the actions are off.
    @state() private submitting = false

    // Why the last save failed, shown above the actions.
    @state() private submitError = ''

    version: string = 'versionplaceholder'

    update(changedProperties: Map<string, any>) {
        if (changedProperties.has('theme')) {
            this.registerTheme(this.theme)
        }

        super.update(changedProperties)
    }

    protected willUpdate(): void {
        // A file or colour field that a condition hides loses its input
        // element, and with it the file or the typed colour; drop that here
        // too, so the field comes back as it started instead of showing what
        // its fresh input does not hold.
        this.chosenFiles = this.withoutHidden(this.chosenFiles, 'file')
        this.typedColors = this.withoutHidden(this.typedColors, 'color')
    }

    // A per-field record without the fields that are no longer of the type or
    // are hidden; the same object when there are none.
    private withoutHidden<T>(byField: Record<number, T>, type: string): Record<number, T> {
        const fields = this.inputData?.formFields ?? []
        const hidden = Object.keys(byField)
            .map(Number)
            .filter((i) => fields[i]?.type !== type || !this.isFieldVisible(fields[i], i))
        if (!hidden.length) return byField
        const kept = { ...byField }
        for (const i of hidden) delete kept[i]
        return kept
    }

    protected firstUpdated(_changedProperties: PropertyValues): void {
        this.registerTheme(this.theme)
    }

    protected updated(_changedProperties: PropertyValues): void {
        this.patchDialogScrim()
        this.patchSecretFields()
        this.toggleAttribute('fab-mode', !!this.inputData?.formButton)
        // The compact density's styles key on the host, so they reach the
        // fields, the dialog's actions and the menus alike.
        this.toggleAttribute('compact', fieldLayoutSettings(this.inputData?.fieldLayout).compact)
    }

    // The patch below per md-dialog element, and the scrim opacity it last
    // set. A flag is not enough: switching the Form Open Button off and on
    // renders a new <md-dialog>, and a theme change can turn the surface from
    // light to dark.
    private scrimPatches = new WeakMap<MdDialog, { sheet: CSSStyleSheet; opacity: number }>()

    // The scrim opacity for the current surface, set in render().
    private scrimOpacity = SCRIM_OPACITY_LIGHT

    /**
     * md-dialog renders its scrim as a `<div class="scrim">` sibling of the
     * native `<dialog>` inside its shadow root, with `position: fixed; z-index: 1`,
     * while disabling the native backdrop (`::backdrop { background: none }`).
     * The `<dialog>` is promoted to the top layer by `showModal()`, but the scrim
     * div stays in the normal layer — confined to this widget's stacking context.
     * As a result it fails to cover sibling dashboard widgets painted in a higher
     * stacking context. We re-enable the native `::backdrop` (which lives in the
     * top layer and spans the whole viewport regardless of ancestor transforms /
     * stacking contexts) and hide the confined internal scrim. Its opacity
     * follows the surface (scrimOpacity), so the sheet is rewritten when that
     * changes; the value is written into the sheet rather than passed as a
     * custom property, because older browsers do not let ::backdrop inherit.
     */
    private patchDialogScrim() {
        const dialog = this.dialog
        const root = dialog?.shadowRoot
        if (!root) return
        let patch = this.scrimPatches.get(dialog)
        if (patch?.opacity === this.scrimOpacity) return
        if (!patch) {
            patch = { sheet: new CSSStyleSheet(), opacity: NaN }
            root.adoptedStyleSheets = [...root.adoptedStyleSheets, patch.sheet]
            this.scrimPatches.set(dialog, patch)
        }
        patch.sheet.replaceSync(`
            dialog::backdrop {
                background: var(--md-sys-color-scrim, #000);
                opacity: ${this.scrimOpacity};
            }
            .scrim {
                display: none !important;
            }
        `)
        patch.opacity = this.scrimOpacity
    }

    /**
     * A secret field's <input> lives in md-outlined-text-field's shadow root,
     * out of reach of this element's styles and of attributes the text field
     * does not forward. Every secret field gets the mask sheet, which draws
     * discs while the host has the masked attribute (only fields without the
     * browser's password manager get it), and the input of such a field gets
     * UNMANAGED_INPUT_ATTRIBUTES; a field switched back to the password
     * manager loses them. The input exists only once the text field has
     * rendered, so that part waits for it.
     */
    private patchSecretFields() {
        const fields = this.renderRoot.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
            'md-outlined-text-field.secret'
        )
        if (!fields.length) return
        const sheet = secretMaskSheet()
        fields.forEach((field) => {
            const root = field.shadowRoot
            if (!root) return
            if (sheet && !root.adoptedStyleSheets.includes(sheet))
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
            const unmanaged = field.classList.contains('unmanaged')
            field.updateComplete.then(() => {
                const input = root.querySelector('input')
                if (!input) return
                for (const [name, value] of UNMANAGED_INPUT_ATTRIBUTES) {
                    if (unmanaged) input.setAttribute(name, value)
                    else input.removeAttribute(name)
                }
            })
        })
    }

    registerTheme(theme?: Theme) {
        this.themeBgColor = `var(--re-tile-background-color, ${this.theme?.theme_object?.backgroundColor || 'transparent'})`
        this.themeTitleColor = `var(--re-text-color, ${this.theme?.theme_object?.title?.textStyle?.color || 'inherit'})`
    }

    openFormDialog() {
        this.dialogOpen = true
    }

    handleFormSubmit(event: Event) {
        event.preventDefault()
        if (this.submitting) return
        const submitter = (event as SubmitEvent).submitter as HTMLElement
        const action = submitter?.getAttribute('value') ?? 'submit'

        const form = event.target as HTMLFormElement
        const formData = new FormData(form)
        const submitData: (ValueItem | FileItem)[] = []
        this.inputData?.formFields?.forEach((field, i) => {
            // A section is a heading: it has no column and writes nothing.
            if (!field || isSection(field)) return
            const targetColumn = {
                swarm_app_databackend_key: field.targetColumn?.swarm_app_databackend_key,
                table_name: field.targetColumn?.tablename,
                column_name: field.targetColumn?.column
            }

            // A field hidden by an unmet conditional-display rule, its own or
            // its section's, is "not applicable": submit null and skip
            // value/default resolution. Its required rule never fired because
            // the element was absent from the DOM.
            if (!field.hiddenField && !this.isFieldVisible(field, i)) {
                submitData.push({ ...targetColumn, value: null })
                if (field.type === 'file') {
                    for (const companion of this.fileCompanions(field))
                        submitData.push({ ...companion.ref, value: null })
                    const urlRef = companionRef(field.fileUrlColumn)
                    if (urlRef) submitData.push({ ...urlRef, value: null })
                }
                return
            }

            if (field.type === 'file') {
                submitData.push(...this.fileFieldItems(field, i, targetColumn, action))
                return
            }

            if (field.type === 'secret') {
                submitData.push(...this.secretFieldItems(i, targetColumn, formData))
                return
            }

            const rawValue = this.currentRawValue(field, i, formData)
            submitData.push({ ...targetColumn, value: this.formatValue(rawValue, field.type ?? 'textfield') })
        })

        if (this.inputData?.deleteFlagColumn)
            submitData.push({
                swarm_app_databackend_key: this.inputData?.deleteFlagColumn?.swarm_app_databackend_key,
                table_name: this.inputData?.deleteFlagColumn?.tablename,
                column_name: this.inputData?.deleteFlagColumn?.column,
                value: action === 'delete'
            })

        // A form that saves a new file needs the host to upload it first. The
        // dialog stays open until the host reports back: md-dialog closes on
        // any method="dialog" submit that reaches it, preventDefault or not.
        if (submitData.some((item) => 'file' in item)) {
            event.stopPropagation()
            this.submitWithFiles(submitData)
            return
        }

        this.submitError = ''
        this.dispatchEvent(
            new CustomEvent('data-submit', {
                detail: submitData,
                bubbles: false,
                composed: false
            })
        )

        if (action === 'delete') {
            const deleteRoute = this.resolveRoute({
                route: this.inputData?.deleteNavigationRoute,
                variables: this.inputData?.variables
            })
            if (deleteRoute) {
                this.dispatchEvent(
                    new CustomEvent('nav-submit', {
                        detail: { path: String(deleteRoute) },
                        bubbles: true,
                        composed: true
                    })
                )
            }
        }

        this.resetForm()
        this.dialogOpen = false
    }

    // The columns a file field writes beside the key, with what each gets.
    fileCompanions(field: Column): { ref: TargetRef; value: (file: File, contentType: string) => unknown }[] {
        const companions = [
            { target: field.fileNameColumn, value: (file: File) => file.name },
            { target: field.fileSizeColumn, value: (file: File) => file.size },
            { target: field.fileTypeColumn, value: (_: File, contentType: string) => contentType }
        ]
        return companions.flatMap(({ target, value }) => {
            const ref = companionRef(target)
            return ref ? [{ ref, value }] : []
        })
    }

    // What a visible file field submits. A new file goes to the host to
    // upload, with its name, size and type for the companion columns and the
    // URL column for the host to fill. Without one the record keeps its file:
    // the pre-filled key is written back, and with no pre-filled key the
    // columns are left out, never set to null, so a table with entity keys
    // carries the previous values over. A delete never uploads.
    fileFieldItems(field: Column, i: number, target: TargetRef, action: string): (ValueItem | FileItem)[] {
        const file = action === 'delete' ? undefined : this.chosenFiles[i]
        const namespace = typeof field.fileNamespace === 'string' ? field.fileNamespace.trim() : ''
        if (file && namespace) {
            const contentType = fileContentType(file, acceptedTypes(field.acceptedFileTypes))
            // The picker refused anything else already; this keeps a
            // mistyped file from slipping through a race.
            if (contentType) {
                // The URL column is cleared ahead of the file item: the host
                // writes the new URL after it, and a later item for a column
                // wins, while a host that writes no URL leaves it empty
                // instead of carrying the previous file's URL over.
                const urlRef = companionRef(field.fileUrlColumn)
                return [
                    ...(urlRef ? [{ ...urlRef, value: null }] : []),
                    { ...target, file, namespace, contentType, ...(urlRef ? { urlColumn: urlRef } : {}) },
                    ...this.fileCompanions(field).map(({ ref, value }) => ({
                        ...ref,
                        value: value(file, contentType)
                    }))
                ]
            }
        }
        const existing = this.effectivePreFilledValue(field)
        return typeof existing === 'string' && existing.trim() ? [{ ...target, value: existing }] : []
    }

    // What a secret field submits: the value typed, as typed (spaces are part
    // of a secret). A saved secret is never read back, so the field has no
    // pre-filled value to write back: left empty, the column is left out,
    // never set to null or '', and a table with entity keys carries the
    // stored secret over. fleetdb's keep sentinel (__secret__) would do the
    // same there, but fails the whole row unseen on other tables and is
    // stored literally in a column that is not secret: true.
    secretFieldItems(i: number, target: TargetRef, formData: FormData): ValueItem[] {
        const typed = formData.get(`column-${i}`)
        return typeof typed === 'string' && typed !== '' ? [{ ...target, value: typed }] : []
    }

    // Hand the save to the host, which stores the files and then writes the
    // rows, and keep the form as it is until it reports back: on success it
    // resets and closes, on failure it stays filled in and says why. With no
    // host to claim the event, nothing is saved.
    async submitWithFiles(items: (ValueItem | FileItem)[]) {
        let outcome: Promise<unknown> | undefined
        const detail: FileDataSubmitDetail = {
            items,
            waitUntil: (promise) => {
                outcome ??= Promise.resolve(promise)
            }
        }
        this.dispatchEvent(new CustomEvent(FILE_DATA_SUBMIT, { detail, bubbles: false, composed: false }))
        if (!outcome) {
            this.submitError =
                'This board cannot upload files: it runs an IronFlock Studio version without file uploads. Nothing was saved.'
            return
        }
        this.submitting = true
        this.submitError = ''
        try {
            await outcome
            this.resetForm()
            this.dialogOpen = false
        } catch (err) {
            const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
            this.submitError = message || 'The file could not be saved. Nothing was written.'
        } finally {
            this.submitting = false
        }
    }

    // Take the file the picker or a drop put into a file field's input, or
    // refuse it with a reason when its type or size is not accepted.
    handleFileChosen(event: Event, field: Column, i: number) {
        const input = event.target as HTMLInputElement
        const file = input.files?.[0]
        this.dragTarget = undefined
        const chosen = { ...this.chosenFiles }
        const errors = { ...this.fileErrors }
        delete chosen[i]
        delete errors[i]
        if (file) {
            const accepted = acceptedTypes(field.acceptedFileTypes)
            const max = maxFileBytes(field)
            if (!fileContentType(file, accepted)) {
                errors[i] = `“${file.name}” is not an accepted file type. Accepted: ${accepted.join(', ')}.`
            } else if (max !== undefined && file.size > max) {
                errors[i] = `“${file.name}” is ${formatBytes(file.size)}, more than the ${formatBytes(max)} this field accepts.`
            } else {
                chosen[i] = file
            }
            // A refused file must not stay in the input, where it would
            // satisfy the field's required rule.
            if (!chosen[i]) input.value = ''
        }
        this.chosenFiles = chosen
        this.fileErrors = errors
    }

    clearChosenFile(event: Event, i: number) {
        const input = (event.currentTarget as HTMLElement)
            .closest('.file-box')
            ?.querySelector<HTMLInputElement>('.file-input')
        if (input) input.value = ''
        const chosen = { ...this.chosenFiles }
        const errors = { ...this.fileErrors }
        delete chosen[i]
        delete errors[i]
        this.chosenFiles = chosen
        this.fileErrors = errors
        if (input?.form) this.refreshFieldValues(input.form)
    }

    // preFilledValue/defaultValue and their *Multiline/*Boolean/*Color twins are
    // separate config keys (the editor shows a single-line, multi-line, checkbox
    // or colour input depending on the field type). Resolve by the current type —
    // normalizing the boolean keys to 'true'/'false' strings for the existing
    // downstream logic — and fall back to the single-line key so fields
    // configured before the split keep their values. A value lingering in a
    // hidden twin key after a type switch is ignored. The editor stores a
    // cleared colour as '', so a blank colour key falls back too.
    effectivePreFilledValue(field: Column): string | undefined {
        if (field.type === 'textarea')
            return (field.preFilledValueMultiline as string | undefined) ?? field.preFilledValue
        if (field.type === 'checkbox')
            return field.preFilledValueBoolean != null
                ? String(field.preFilledValueBoolean)
                : field.preFilledValue
        if (field.type === 'color') return colorKey(field.preFilledValueColor) ?? field.preFilledValue
        return field.preFilledValue
    }

    effectiveDefaultValue(field: Column): string | undefined {
        if (field.type === 'textarea')
            return (field.defaultValueMultiline as string | undefined) ?? field.defaultValue
        if (field.type === 'checkbox')
            return field.defaultValueBoolean != null ? String(field.defaultValueBoolean) : field.defaultValue
        if (field.type === 'color') return colorKey(field.defaultValueColor) ?? field.defaultValue
        return field.defaultValue
    }

    formatValue(value: string, type: string): any {
        switch (type) {
            case 'numberfield': {
                if (value === '' || value === null || value === undefined) return null
                const n = parseFloat(value)
                return Number.isNaN(n) ? null : n
            }
            case 'checkbox':
                return value === 'on' || value === 'true' ? true : false
            // A colour goes in as hex. A text that is no colour can only be
            // a pre-filled value nobody changed (typing one blocks the
            // save), so it is written back as it was.
            case 'color': {
                const text = typeof value === 'string' ? value.trim() : ''
                return text ? (colorHex(text) ?? text) : null
            }
            default:
                return value
        }
    }

    // Resolve a field's current raw (string) value, applying the same
    // empty-falls-back-to-default rule used at submit so condition evaluation and
    // submission agree. Checkbox is normalized to 'true'/'false' (matching the
    // literals designers use in a condition list); a field absent from the DOM
    // (hidden by its own condition) yields its effective default value.
    currentRawValue(field: Column, i: number, formData: FormData): string {
        const name = `column-${i}`
        if (field.hiddenField)
            return this.effectivePreFilledValue(field) ?? this.effectiveDefaultValue(field) ?? ''
        // A file field holds the name of its new file, or else the key of the
        // record's current one.
        if (field.type === 'file') return this.chosenFiles[i]?.name ?? this.effectivePreFilledValue(field) ?? ''
        // A secret field holds only what was typed; a saved one is never read back.
        if (field.type === 'secret') {
            const typed = formData.get(name)
            return typeof typed === 'string' ? typed : ''
        }
        if (field.type === 'checkbox') return formData.has(name) ? 'true' : 'false'
        const entry = formData.get(name)
        return entry === null || entry === '' ? (this.effectiveDefaultValue(field) ?? '') : String(entry)
    }

    // Rebuild the label→value map on every input/change so conditional-display
    // rules re-evaluate live. A single delegated listener on the <form> catches
    // all field types (Material components bubble input/change within this root).
    handleFieldChange(event: Event) {
        const form = event.currentTarget as HTMLFormElement
        if (form) this.refreshFieldValues(form)
    }

    // Sections hold no value: one with a field's label must not shadow it.
    refreshFieldValues(form: HTMLFormElement) {
        const formData = new FormData(form)
        const values: Record<string, string> = {}
        this.inputData?.formFields?.forEach((field, i) => {
            if (field?.label && !isSection(field))
                values[field.label] = this.currentRawValue(field, i, formData)
        })
        this.fieldValues = values
    }

    // Whether the entry at index i is shown: its own conditional-display rule
    // holds and, for a field in a section's group, the section's rule too, so
    // a section shows or hides its whole group.
    isFieldVisible(field: Column, i: number): boolean {
        if (!isSection(field)) {
            const fields = this.inputData?.formFields ?? []
            const section = sectionOf(fields, i)
            if (section !== undefined && !this.passesCondition(fields[section])) return false
        }
        return this.passesCondition(field)
    }

    // An entry passes unless it declares a conditional-display rule whose
    // controlling field (referenced by label; a section never controls) does
    // not currently hold one of the listed values. Fail-open on
    // misconfiguration (unknown field / empty list) so a half-configured rule
    // never silently hides a field and its data.
    passesCondition(field: Column): boolean {
        const ref = field.conditionalDisplay?.conditionField?.trim()
        if (!ref) return true
        const allowed = (field.conditionalDisplay?.conditionValues ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== '')
        if (allowed.length === 0) return true
        const controller = this.inputData?.formFields?.find((f) => f?.label === ref && !isSection(f))
        if (!controller) return true
        const current =
            this.fieldValues[ref] ??
            this.effectivePreFilledValue(controller) ??
            this.effectiveDefaultValue(controller) ??
            ''
        return allowed.includes(String(current))
    }

    renderTextField(field: Column, i: number, layout: string) {
        return html`
            <md-outlined-text-field
                class=${layout}
                .name="column-${i}"
                .label="${field.label ?? ''}"
                .type="${field.type === 'numberfield' ? 'number' : 'text'}"
                .value="${field.preFilledValue ?? ''}"
                .placeholder="${field.defaultValue ?? ''}"
                .pattern="${browserSafePattern(field.validation)}"
                supporting-text=${field.description ?? ''}
                @input=${(event: Event) => this.syncValidationMessage(event, field)}
                ?required=${field.required && !field.defaultValue && !field.preFilledValue}
            ></md-outlined-text-field>
        `
    }

    // The Validation Message in place of the browser's generic "Please match
    // the requested format", which says nothing about a value one cannot see.
    // md-outlined-text-field has no setting for it (a validation-message
    // attribute does nothing), so it is the field's custom validity while the
    // value does not match the Validation Regex. md-outlined-text-field shows
    // it as the error once the form reports validity, as on Submit.
    syncValidationMessage(event: Event, field: Column) {
        const target = event.currentTarget as HTMLElement & {
            setCustomValidity?: (message: string) => void
            validity?: ValidityState
        }
        if (typeof target.setCustomValidity !== 'function') return
        const message = typeof field.validationMessage === 'string' ? field.validationMessage.trim() : ''
        target.setCustomValidity('')
        if (message && target.validity?.patternMismatch) target.setCustomValidity(message)
    }

    renderNumberField(field: Column, i: number, layout: string) {
        return html`
            <md-outlined-text-field
                class="fixed-width ${layout}"
                .name="column-${i}"
                .label="${field.label ?? ''}"
                type="number"
                .value="${field.preFilledValue ?? ''}"
                .placeholder="${field.defaultValue ?? ''}"
                step="any"
                min=${field.min ?? ''}
                max=${field.max ?? ''}
                supporting-text=${field.description ?? ''}
                ?required=${field.required && !field.defaultValue && !field.preFilledValue}
            ></md-outlined-text-field>
        `
    }

    renderCheckbox(field: Column, i: number, layout: string) {
        const preFilledValue = this.effectivePreFilledValue(field)
        const defaultValue = this.effectiveDefaultValue(field)
        return html`
            <div class="checkbox-container ${layout}">
                <md-checkbox
                    name="column-${i}"
                    aria-label=${field.label ?? ''}
                    ?checked=${String(preFilledValue ?? defaultValue) === 'true'}
                    ?required=${field.required && !defaultValue && !preFilledValue}
                ></md-checkbox>
                <label class="label">
                    ${field.label}
                    ${field.description
                        ? html`<span class="supporting-text">${field.description}</span>`
                        : nothing}
                </label>
            </div>
        `
    }

    renderTextArea(field: Column, i: number, layout: string) {
        const preFilledValue = this.effectivePreFilledValue(field)
        const defaultValue = this.effectiveDefaultValue(field)
        return html`
            <md-outlined-text-field
                class=${layout}
                .name="column-${i}"
                .label="${field.label ?? ''}"
                type="textarea"
                .value="${preFilledValue ?? ''}"
                .placeholder="${defaultValue ?? ''}"
                rows="3"
                ?required=${field.required && !defaultValue && !preFilledValue}
                supporting-text=${field.description ?? ''}
            ></md-outlined-text-field>
        `
    }

    renderDropdown(field: Column, i: number, layout: string) {
        // Bind the value on the select itself (not just `selected` on the option):
        // md-outlined-select only reports its `value` to the form via ElementInternals,
        // and the declarative `selected` attribute does not reliably sync into it — so
        // a prefilled option would display but submit empty.
        // The caption is the select's own floating label, as on the text fields,
        // so a select lines up with a text field beside it. Never a <label>
        // around the select: a label sends its control a second click, which in
        // Firefox closes the menu the first one opened.
        return html`
            <md-outlined-select
                class=${layout}
                name="column-${i}"
                .label=${field.label ?? ''}
                aria-label=${field.label ?? nothing}
                .value=${field.preFilledValue ?? field.defaultValue ?? ''}
                supporting-text=${field.description ?? ''}
                ?required=${field.required && !field.defaultValue && !field.preFilledValue}
            >
                ${repeat(
                    field.values ?? [],
                    (val) => val.value,
                    (val) => {
                        return html`
                            <md-select-option .value="${val.value ?? ''}">
                                ${val.displayLabel}
                            </md-select-option>
                        `
                    }
                )}
            </md-outlined-select>
        `
    }

    renderDateTimeField(field: Column, i: number, layout: string) {
        return html`
            <md-outlined-text-field
                class="fixed-width ${layout}"
                .name="column-${i}"
                .label="${field.label ?? ''}"
                type="datetime-local"
                .value="${field.preFilledValue ?? field.defaultValue ?? ''}"
                supporting-text=${field.description ?? ''}
                ?required=${field.required && !field.defaultValue && !field.preFilledValue}
            ></md-outlined-text-field>
        `
    }

    // A text field for the colour, with a swatch in its trailing slot that
    // shows it and opens the browser's colour picker: a transparent native
    // colour input is stretched over the swatch, as over the file drop zone.
    // The text field holds the value, so the field can be empty and required
    // and takes a typed or pasted colour; a native colour input is never
    // empty and knows only #rrggbb. The values are shown as hex, the way they
    // are stored, and an empty field's swatch shows its default colour, which
    // a save stores then.
    renderColorField(field: Column, i: number, layout: string) {
        const preFilledValue = this.effectivePreFilledValue(field)
        const defaultValue = this.effectiveDefaultValue(field)
        const typed = this.typedColors[i]
        const text = typed && typed.over === preFilledValue ? typed.text : (preFilledValue ?? '')
        const shown = colorHex(text.trim() ? text : defaultValue)
        return html`
            <md-outlined-text-field
                class="fixed-width ${layout}"
                .name="column-${i}"
                .label="${field.label ?? ''}"
                .value="${colorHex(preFilledValue) ?? preFilledValue ?? ''}"
                .placeholder="${colorHex(defaultValue) ?? defaultValue ?? ''}"
                supporting-text=${field.description ?? ''}
                @input=${(event: Event) => this.handleColorTyped(event, field, i)}
                @change=${(event: Event) => this.handleColorCommitted(event, field, i)}
                ?required=${field.required && !defaultValue && !preFilledValue}
            >
                <span
                    slot="trailing-icon"
                    class="color-swatch"
                    ?empty=${!shown}
                    style=${shown ? `--swatch-color: ${shown}` : nothing}
                >
                    <input
                        type="color"
                        class="color-input"
                        aria-label="Pick ${field.label || 'a color'}"
                        .value=${shown?.slice(0, 7) ?? '#000000'}
                        @input=${(event: Event) => this.handleColorPicked(event, field, i)}
                    />
                </span>
            </md-outlined-text-field>
        `
    }

    // A colour field's text field, for the events that come from it rather
    // than from the native picker in its trailing slot, which bubble through
    // it too.
    private colorTextField(event: Event): ColorTextField | undefined {
        const field = event.currentTarget as ColorTextField
        return event.target === field ? field : undefined
    }

    // A colour for the swatch, and an error on Submit when the text is none.
    private setColorText(textField: ColorTextField, field: Column, i: number) {
        const text = textField.value
        textField.setCustomValidity(text.trim() && !colorHex(text) ? COLOR_MESSAGE : '')
        this.typedColors = { ...this.typedColors, [i]: { text, over: this.effectivePreFilledValue(field) } }
    }

    handleColorTyped(event: Event, field: Column, i: number) {
        const textField = this.colorTextField(event)
        if (textField) this.setColorText(textField, field, i)
    }

    // Once typed, the colour is shown as the hex it is stored as.
    handleColorCommitted(event: Event, field: Column, i: number) {
        const textField = this.colorTextField(event)
        if (!textField) return
        const hex = colorHex(textField.value)
        if (hex) textField.value = hex
        this.setColorText(textField, field, i)
    }

    // The picker sets the colour; a translucent one typed before keeps its
    // alpha, which the picker cannot show.
    handleColorPicked(event: Event, field: Column, i: number) {
        const picker = event.target as HTMLInputElement
        const textField = picker.closest<ColorTextField>('md-outlined-text-field')
        if (!textField) return
        textField.value = picker.value + (colorHex(textField.value)?.slice(7) ?? '')
        this.setColorText(textField, field, i)
    }

    // A masked text field that always starts empty: a saved secret is never
    // read back, and leaving the field empty keeps it (secretFieldItems()).
    // The eye button shows what was typed.
    //
    // With Browser Password Manager on it is a password input, and
    // autocomplete="new-password" keeps the browser from filling in the
    // viewer's saved IronFlock login. Off, the default: browsers and password
    // manager extensions offer to save any password input, autocomplete="off"
    // or not, which gets in the way of a PIN. So it is a text input masked by
    // -webkit-text-security (patchSecretFields()), autocomplete="off" keeps
    // the value out of the browser's form history, and copying is blocked
    // while it is masked, as a password input does.
    renderSecretField(field: Column, i: number, layout: string) {
        const revealed = !!this.revealedSecrets[i]
        const managed = field.browserPasswordManager === true
        const masked = !managed && !revealed
        const name = field.label || 'value'
        const blockCopy = (event: Event) => {
            if (masked) event.preventDefault()
        }
        return html`
            <md-outlined-text-field
                class="${managed ? 'secret' : 'secret unmanaged'} ${layout}"
                ?masked=${masked}
                .name="column-${i}"
                .label="${field.label ?? ''}"
                .type=${managed && !revealed ? 'password' : 'text'}
                autocomplete=${managed ? 'new-password' : 'off'}
                @copy=${blockCopy}
                @cut=${blockCopy}
                placeholder=${field.required ? '' : 'Leave empty to keep the current value'}
                .pattern="${browserSafePattern(field.validation)}"
                supporting-text=${field.description ?? ''}
                @input=${(event: Event) => this.syncValidationMessage(event, field)}
                ?required=${!!field.required}
            >
                <md-icon-button
                    slot="trailing-icon"
                    type="button"
                    aria-label="${revealed ? 'Hide' : 'Show'} ${name}"
                    @click=${() => (this.revealedSecrets = { ...this.revealedSecrets, [i]: !revealed })}
                    ><md-icon>${revealed ? 'visibility_off' : 'visibility'}</md-icon></md-icon-button
                >
            </md-outlined-text-field>
        `
    }

    // A drop zone over a transparent native file input: the input takes the
    // clicks, the keyboard focus and the drops itself, and its required rule
    // and the browser's message sit on the box. The box shows the new file,
    // or else the record's current file (the pre-filled key, whose last
    // segment is the file's name).
    renderFileField(field: Column, i: number, layout: string) {
        const accepted = acceptedTypes(field.acceptedFileTypes)
        const max = maxFileBytes(field)
        const file = this.chosenFiles[i]
        const prefilled = this.effectivePreFilledValue(field)
        const existingKey = typeof prefilled === 'string' ? prefilled.trim() : ''
        const namespace = typeof field.fileNamespace === 'string' ? field.fileNamespace.trim() : ''
        const error = namespace
            ? this.fileErrors[i]
            : 'This field has no File Namespace set, so it cannot store a file.'
        const required = !!field.required && !existingKey
        const disabled = !namespace || this.submitting
        const limits = [accepted.join(', '), max !== undefined ? `up to ${formatBytes(max)}` : '']
            .filter(Boolean)
            .join(' · ')
        const name = file ? file.name : existingKey ? fileNameOfKey(existingKey) : 'Choose a file or drop it here'
        const meta = file
            ? formatBytes(file.size)
            : existingKey
              ? 'Current file. Choose or drop another one to replace it.'
              : limits
        // Over a disabled input a drop would fall through to the browser,
        // which opens the file in place of the board.
        const blockDrop = (event: DragEvent) => {
            if (disabled) event.preventDefault()
        }
        return html`
            <div class="label file-field ${layout}">
                <span>${field.label}${required ? ' *' : ''}</span>
                <div
                    class="file-box"
                    ?drag-over=${this.dragTarget === i}
                    ?invalid=${!!error}
                    ?disabled=${disabled}
                    @dragover=${blockDrop}
                    @drop=${(event: DragEvent) => {
                        this.dragTarget = undefined
                        blockDrop(event)
                    }}
                >
                    <md-icon aria-hidden="true">${file || existingKey ? 'description' : 'upload_file'}</md-icon>
                    <div class="file-text">
                        <span class="file-name">${name}</span>
                        ${meta ? html`<span class="file-meta">${meta}</span>` : nothing}
                    </div>
                    <input
                        type="file"
                        class="file-input"
                        aria-label=${field.label || 'File'}
                        aria-describedby="file-hint-${i}"
                        accept=${ifDefined(acceptAttribute(accepted) || undefined)}
                        ?required=${required}
                        ?disabled=${disabled}
                        @change=${(event: Event) => this.handleFileChosen(event, field, i)}
                        @dragenter=${() => (this.dragTarget = i)}
                        @dragleave=${() => (this.dragTarget = undefined)}
                    />
                    ${file
                        ? html`<md-icon-button
                              class="file-clear"
                              type="button"
                              aria-label="Remove ${file.name}"
                              ?disabled=${this.submitting}
                              @click=${(event: Event) => this.clearChosenFile(event, i)}
                              ><md-icon>close</md-icon></md-icon-button
                          >`
                        : nothing}
                </div>
                <span id="file-hint-${i}" class="supporting-text ${error ? 'error' : ''}"
                    >${error || field.description || ''}</span
                >
            </div>
        `
    }

    // A heading across the row that groups the fields after it, with the Hint
    // Text under it. h4 and a div rather than h3 and p: the shadow root styles
    // those for the form's own title and subtitle.
    renderSection(field: Column) {
        return html`
            <div class="section">
                ${field.label ? html`<h4>${field.label}</h4>` : nothing}
                ${field.description ? html`<div class="section-hint">${field.description}</div>` : nothing}
            </div>
        `
    }

    // Why the last save failed, above the actions; announced when it appears.
    renderSubmitError() {
        return this.submitError ? html`<div class="form-error" role="alert">${this.submitError}</div>` : nothing
    }

    resetForm() {
        this.formKey++
        this.fieldValues = {}
        this.chosenFiles = {}
        this.fileErrors = {}
        this.revealedSecrets = {}
        this.typedColors = {}
        this.submitError = ''
    }

    resolveRoute(item?: any): string | undefined {
        let route: string = item?.route ?? ''
        if (!route) return undefined
        if (item?.variables) {
            for (const variable of item.variables) {
                if (variable.label) {
                    route = route
                        .split(`{{${variable.label}}}`)
                        .join(encodeURIComponent(String(variable.value ?? '')))
                }
            }
        }
        if (route.includes('*')) {
            const currentSegments = (this.route || '').split('/').filter(Boolean)
            const routeSegments = route.split('/').filter(Boolean)
            for (let i = 0; i < routeSegments.length; i++) {
                if (routeSegments[i] === '*') {
                    routeSegments[i] = currentSegments[i] ?? ''
                }
            }
            route = (route.startsWith('/') ? '/' : '') + routeSegments.filter(Boolean).join('/')
        }
        return route
    }

    cancelEdit(event: Event) {
        this.resetForm()
        this.dialogOpen = false
    }

    static styles = css`
        :host {
            display: flex;
            flex-direction: column;
            font-family: sans-serif;
            box-sizing: border-box;
            position: relative;
            margin: auto;
        }

        /* In fab mode only the floating button is shown, so the widget tile
           itself should never paint a background. !important beats an outer
           tile-background rule (shadow !important wins over the outer tree). */
        :host([fab-mode]) {
            background: transparent !important;
        }

        .paging:not([active]) {
            display: none !important;
        }

        .wrapper {
            display: flex;
            flex-direction: column;
            padding: 16px;
            box-sizing: border-box;
            overflow: auto;
            /* Derive scrollbar colors from the (inherited) text color so they
               follow custom styles and themes — e.g. light thumb on dark bg. */
            scrollbar-width: thin;
            scrollbar-color: color-mix(in srgb, currentColor 35%, transparent) transparent;
        }

        /* WebKit/Blink fallback for browsers without scrollbar-color support. */
        .wrapper::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        .wrapper::-webkit-scrollbar-track {
            background: transparent;
        }

        .wrapper::-webkit-scrollbar-thumb {
            background-color: color-mix(in srgb, currentColor 35%, transparent);
            border-radius: 4px;
        }

        .wrapper::-webkit-scrollbar-thumb:hover {
            background-color: color-mix(in srgb, currentColor 55%, transparent);
        }

        /* Wrap rather than overflow: with justify-content: flex-end an
           overflowing row spills out of the left edge, where no scrolling
           reaches, and a narrow tile would hide its leftmost buttons. */
        .form-actions {
            display: flex;
            flex-direction: row;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }

        h3 {
            margin: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding: 16px 0px 0px 16px;
            box-sizing: border-box;
        }
        p {
            margin: 10px 0 16px 0;
            font-size: 14px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-left: 16px;
            box-sizing: border-box;
        }

        /* The dialog classes */
        .form {
            /* Fields take a full row unless the Field Layout or their Width
               says otherwise, so a wide dialog would just stretch most forms
               unreadably. Cap at a comfortable form width but shrink to fit
               narrow viewports. Height stays content-driven
               (Material's fit-content), capped at 80% of the viewport. A Form
               Dialog Size minimum goes inline on md-dialog (dialogSizeStyle)
               and wins over both whenever it is larger. */
            width: min(90vw, 480px);
            max-height: 80vh;
        }

        .form [slot='header'] {
            display: flex;
            flex-direction: row-reverse;
            align-items: center;
        }

        .form .headline {
            flex: 1;
        }

        /* md-dialog lays the actions out as a right-aligned flex row with an
           8px gap and clips what overflows its container, so without wrapping
           a narrow window hides the leftmost buttons, Delete first. */
        .form [slot='actions'] {
            flex-wrap: wrap;
        }

        /* The fields sit on a 12-column grid and fill it left to right in
           field order; a field that does not fit on the current row starts
           the next one. Each spans a full row unless its Width or the Field
           Layout says otherwise, which is the single column every form had
           before. align-items: start keeps a field from being stretched to
           the height of a taller one beside it (md-outlined-text-field fills
           whatever height it gets, so its outline would grow). The form is
           a size container: the collapse rules render() adds (collapseRules())
           measure it, so the layout follows the tile or the dialog without a
           ResizeObserver. */
        .form-content {
            display: grid;
            grid-template-columns: repeat(12, minmax(0, 1fr));
            column-gap: 16px;
            row-gap: 24px;
            align-items: start;
            container-type: inline-size;
        }

        /* Longhands, so that .new-row's start line survives. */
        .w-full {
            grid-column-end: span 12;
        }
        .w-three-quarters {
            grid-column-end: span 9;
        }
        .w-two-thirds {
            grid-column-end: span 8;
        }
        .w-half {
            grid-column-end: span 6;
        }
        .w-third {
            grid-column-end: span 4;
        }
        .w-quarter {
            grid-column-end: span 3;
        }

        .new-row {
            grid-column-start: 1;
        }

        /* Number, date and colour fields keep the 200px they always had on a
           full row, shrinking with a narrower form; on part of a row they
           fill their share of it. */
        .form-content > .fixed-width.w-full {
            width: 200px;
            max-width: 100%;
        }

        /* A checkbox on part of a row sits in the middle of the 56px of the
           text fields' boxes beside it. On a row of its own it keeps the
           height it always had. */
        .form-content > .checkbox-container:not(.w-full) {
            min-height: 56px;
        }

        /* A section heading spans the row, set off by a line from the fields
           above it, unless it is the first thing in the form. The negative
           margin brings its group 8px closer than the grid's row gap. */
        .form-content > .section {
            grid-column: 1 / -1;
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding-top: 16px;
            margin-bottom: -8px;
            border-top: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        }

        .form-content > .section:first-child {
            padding-top: 0;
            border-top: none;
        }

        .section h4 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            line-height: 24px;
        }

        .section-hint {
            font-size: 14px;
            line-height: 20px;
            color: var(--md-sys-color-on-surface-variant);
        }

        .checkbox-container {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* The box has a fixed size, so it must not absorb the shrinking when a long
           label wraps in a narrow container - only the label may give way. */
        .checkbox-container md-checkbox {
            flex: 0 0 auto;
        }

        .checkbox-container .label {
            min-width: 0;
        }

        .label {
            display: flex;
            flex-direction: column;
        }

        /* md-checkbox has no supporting-text of its own, unlike md-outlined-text-field
           and md-outlined-select, so the hint is rendered by hand to match theirs. */
        .supporting-text {
            font-size: 12px;
            line-height: 16px;
            color: var(--md-sys-color-on-surface-variant);
        }

        /* Material gives the select a 210px minimum, which pushed a select on
           part of a row into its neighbour; its share of the row (at least
           the Minimum Field Width) is the minimum now. */
        md-outlined-select {
            min-width: 0;
        }

        .file-field {
            gap: 4px;
        }

        /* Indented like the supporting text of the outlined fields. */
        .file-field .supporting-text {
            padding: 0 16px;
        }

        /* Sized like an outlined text field, dashed while it waits for a file. */
        .file-box {
            position: relative;
            display: flex;
            align-items: center;
            gap: 12px;
            min-height: 56px;
            padding: 8px 8px 8px 16px;
            box-sizing: border-box;
            border: 1px dashed var(--md-sys-color-outline);
            border-radius: 4px;
        }

        .file-box:hover:not([disabled]),
        .file-box[drag-over] {
            border-style: solid;
        }

        .file-box[drag-over] {
            border-width: 2px;
            padding-left: 15px;
        }

        .file-box:has(.file-input:focus-visible) {
            outline: 2px solid currentColor;
            outline-offset: 2px;
        }

        .file-box[invalid] {
            border-color: var(--md-sys-color-error, #b3261e);
        }

        .file-box[disabled] {
            opacity: 0.6;
        }

        /* The input covers the box, so clicks and drops anywhere on it reach
           the file picker; only the clear button sits above it. */
        .file-input {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            opacity: 0;
            cursor: pointer;
        }

        .file-input:disabled {
            cursor: default;
        }

        .file-text {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-width: 0;
        }

        .file-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .file-meta {
            font-size: 12px;
            line-height: 16px;
            opacity: 0.8;
        }

        .file-clear {
            position: relative;
            z-index: 1;
            flex: 0 0 auto;
        }

        /* The colour over a checkerboard, so a translucent one shows as
           such; a diagonal stroke while the field holds none. The outline
           keeps a colour like the surface visible. */
        .color-swatch {
            position: relative;
            width: 24px;
            height: 24px;
            box-sizing: border-box;
            border: 1px solid var(--md-sys-color-outline);
            border-radius: 4px;
            background:
                linear-gradient(var(--swatch-color), var(--swatch-color)),
                repeating-conic-gradient(#c8c8c8 0 25%, #ffffff 0 50%) 0 0 / 8px 8px;
        }

        .color-swatch[empty] {
            background: linear-gradient(
                to top right,
                transparent calc(50% - 0.75px),
                currentColor calc(50% - 0.75px) calc(50% + 0.75px),
                transparent calc(50% + 0.75px)
            );
        }

        .color-swatch:has(.color-input:focus-visible) {
            outline: 2px solid currentColor;
            outline-offset: 2px;
        }

        /* The native picker covers the swatch, so a click or a key press on
           it opens the browser's colour picker. */
        .color-input {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 0;
            border: 0;
            opacity: 0;
            cursor: pointer;
        }

        .supporting-text.error,
        .form-error {
            color: var(--md-sys-color-error, #b3261e);
        }

        .form-error {
            flex-basis: 100%;
            margin-top: 16px;
            font-size: 14px;
        }

        md-dialog {
            overflow: visible;
        }

        .header {
            display: flex;
            align-items: center;
            --md-fab-icon-color: white;
            --md-fab-container-color: #007bff;
            --md-fab-label-text-color: white;
        }

        /* A long label is cut with an ellipsis, inside the tile. */
        .open-btn {
            margin: 8px;
            max-width: calc(100% - 16px);
        }

        .delete-btn {
            --md-filled-button-container-color: #d32f2f;
            --md-filled-button-label-text-color: #fff;
            --md-filled-button-hover-label-text-color: #fff;
            --md-filled-button-focus-label-text-color: #fff;
            --md-filled-button-pressed-label-text-color: #fff;
        }

        /* Density compact (updated() sets the attribute): fields 40px high
           instead of Material's 56 (8px above and below the 24px line instead
           of 16) with 14px text, 32px buttons, smaller icon buttons and
           checkbox halos, and tighter gaps. A text field has tokens of its
           own; a select's inner field reads the outlined field's tokens
           directly. The column gap is COMPACT_FIELD_GAP, which the collapse
           rules are computed with. The open button keeps its own Size. */
        :host([compact]) {
            --md-outlined-text-field-top-space: 8px;
            --md-outlined-text-field-bottom-space: 8px;
            --md-outlined-text-field-leading-space: 12px;
            --md-outlined-text-field-trailing-space: 12px;
            --md-outlined-text-field-input-text-size: 14px;
            --md-outlined-text-field-label-text-size: 14px;
            --md-outlined-field-top-space: 8px;
            --md-outlined-field-bottom-space: 8px;
            --md-outlined-field-leading-space: 12px;
            --md-outlined-field-trailing-space: 12px;
            --md-outlined-select-text-field-input-text-size: 14px;
            --md-outlined-select-text-field-label-text-size: 14px;
            --md-icon-button-state-layer-height: 32px;
            --md-icon-button-state-layer-width: 32px;
            --md-icon-button-icon-size: 20px;
            --md-checkbox-state-layer-size: 32px;
            --md-filled-button-container-height: 32px;
            --md-outlined-button-container-height: 32px;
        }

        :host([compact]) .form-content {
            row-gap: 16px;
            column-gap: 12px;
        }

        :host([compact]) .form-content > .checkbox-container:not(.w-full) {
            min-height: 40px;
        }

        :host([compact]) .checkbox-container .label,
        :host([compact]) .file-field > span:first-child,
        :host([compact]) .file-name {
            font-size: 14px;
        }

        :host([compact]) .form-content > .section:not(:first-child) {
            padding-top: 12px;
        }

        :host([compact]) .form-content > .section {
            margin-bottom: -4px;
        }

        :host([compact]) .section h4 {
            font-size: 14px;
            line-height: 20px;
        }

        :host([compact]) .section-hint {
            font-size: 12px;
            line-height: 16px;
        }

        :host([compact]) .file-box {
            min-height: 40px;
            padding: 4px 4px 4px 12px;
        }

        :host([compact]) .color-swatch {
            width: 20px;
            height: 20px;
        }

        :host([compact]) .form-actions {
            margin-top: 12px;
        }
    `

    /**
     * Opaque colour for the dialog and the select menus, which float above
     * the tile and must hide whatever is beneath them.
     *
     * --re-text-color is picked to read on the tile as it is displayed:
     * --re-tile-background-color over the dashboard's --re-background-color,
     * over the dashboard view's white. That composite is the surface, so text
     * on it reads as well as on the tile, even where the tile colour is
     * transparent or translucent. The theme background fills in for a missing
     * tile colour or, standalone with no dashboard around the widget, for the
     * dashboard's. The colours are read here, at render time, because the
     * var() chains in registerTheme() cannot be picked apart in JS. Studio
     * 3.5.7 and earlier painted --re-background-color twice under the tiles, so
     * there a translucent dashboard colour stacked up on screen and the surface
     * came out a little lighter than the tile; opaque and fully transparent
     * dashboard colours were exact, and later studios paint it once.
     */
    private surfaceColor(): string {
        const style = getComputedStyle(this)
        const tile = style.getPropertyValue('--re-tile-background-color').trim()
        const dashboard = style.getPropertyValue('--re-background-color').trim()
        const themeBg = String(this.theme?.theme_object?.backgroundColor ?? '')
        return opaqueSurface(dashboard ? [dashboard, tile || themeBg] : [themeBg, tile])
    }

    render() {
        const fontColor = this.themeTitleColor
        const bgColor = this.themeBgColor
        const bgColorOpaque = this.surfaceColor()
        // The dialog and the menus float above the tile: on a dark surface
        // they are raised and the scrim deepens (raisedSurface()).
        const raisedColor = raisedSurface(bgColorOpaque)
        const darkSurface = isDarkSurface(bgColorOpaque)
        this.scrimOpacity = darkSurface ? SCRIM_OPACITY_DARK : SCRIM_OPACITY_LIGHT
        // The fields sit in the dialog in Form Open Button mode, else on the tile.
        const { primary, onPrimary } = accentColors(
            this.inputData?.accentColor,
            this.theme?.theme_object?.color?.[0],
            this.inputData?.formButton ? raisedColor : bgColorOpaque,
            fontColor
        )
        // The label names the form, since a custom icon need not mean "add".
        const buttonStyle = openButtonStyle(this.inputData?.formButtonStyle)
        const title = this.inputData?.title
        const fabLabel = typeof title === 'string' && title.trim() ? title.trim() : 'Open form'
        const fabShape = buttonStyle.cornerRadius
            ? FAB_SHAPE_SIZES.map(
                  (size) => `--md-fab-${size}container-shape: ${buttonStyle.cornerRadius};`
              ).join(' ')
            : ''
        // Fields widen in a form too narrow for them; the thresholds follow
        // the Minimum Field Width and the density's gap, so the rules are
        // written here.
        const layoutSettings = fieldLayoutSettings(this.inputData?.fieldLayout)
        const collapse = collapseRules(
            layoutSettings.minFieldWidth,
            layoutSettings.compact ? COMPACT_FIELD_GAP : FIELD_GAP
        )
        return html`
            <style>
                :host {
                    --md-sys-color-on-surface: ${fontColor};
                    --md-sys-color-on-surface-variant: ${fontColor};
                    --md-sys-color-outline: ${fontColor};
                    --md-sys-color-surface-container: ${bgColorOpaque};
                    /* The highlight colour (accentColors()) in place of
                       Material's fixed purple, and the keyboard focus ring
                       with it. */
                    --md-sys-color-primary: ${primary};
                    --md-sys-color-on-primary: ${onPrimary};
                    --md-focus-ring-color: ${primary};
                    /* Error text and outlines: Material's light-scheme red
                       does not read on a dark surface, its dark-scheme one
                       does. */
                    --md-sys-color-error: ${darkSurface ? ERROR_ON_DARK : ERROR_ON_LIGHT};
                    /* Dialog container and select dropdown panel are opaque
                       (surfaceColor()), so they hide what is beneath them
                       whatever the tile's background, and raised above a dark
                       surface (raisedSurface()), so they stand out from it. */
                    --md-dialog-container-color: ${raisedColor};
                    --md-menu-container-color: ${raisedColor};
                    --md-menu-item-selected-container-color: ${raisedColor};
                    --md-menu-item-selected-label-text-color: ${fontColor};
                    /* Reset and Cancel take the text colour, which reads on the
                       surface, instead of Material's fixed purple primary, which
                       does not on a dark one. Their outline already does. */
                    --md-outlined-button-label-text-color: ${fontColor};
                    --md-outlined-button-hover-label-text-color: ${fontColor};
                    --md-outlined-button-focus-label-text-color: ${fontColor};
                    --md-outlined-button-pressed-label-text-color: ${fontColor};
                    --md-outlined-button-hover-state-layer-color: ${fontColor};
                    --md-outlined-button-pressed-state-layer-color: ${fontColor};
                    color: ${fontColor};
                }
                ${collapse}
            </style>
            <div class="header">
                ${this.inputData?.formButton
                    ? !buttonStyle.fab
                        ? this.renderOpenButton(buttonStyle, fabLabel, bgColorOpaque)
                        : html`
                              <md-fab
                                  aria-label=${fabLabel}
                                  .size=${buttonStyle.size}
                                  style="margin: 8px; --md-fab-container-color: ${(buttonStyle.bgColor ||
                                      this.theme?.theme_object?.color?.[0]) ??
                                  '#9064f7'}; --md-fab-icon-color: ${(buttonStyle.color ||
                                      this.theme?.theme_object?.color?.[1]) ??
                                  '#fff'}; ${fabShape}"
                                  @click=${this.openFormDialog}
                              >
                                  <md-icon slot="icon">${buttonStyle.iconName}</md-icon>
                              </md-fab>
                          `
                    : nothing}
                ${!this.inputData?.formButton
                    ? html`
                          <header>
                              <h3 class="paging" ?active=${this.inputData?.title}>
                                  ${this.inputData?.title}
                              </h3>
                              <p class="paging" ?active=${this.inputData?.subTitle}>
                                  ${this.inputData?.subTitle}
                              </p>
                          </header>
                      `
                    : nothing}
            </div>
            ${!this.inputData?.formButton
                ? html`
                      <div class="wrapper">
                          ${this.renderForm()} ${this.renderSubmitError()}
                          <div class="form-actions">
                              ${this.inputData?.deleteButton
                                  ? html`<md-filled-button
                                        class="delete-btn"
                                        form="form"
                                        value="delete"
                                        type="submit"
                                        ?disabled=${this.submitting}
                                        >Delete</md-filled-button
                                    >`
                                  : nothing}
                              <md-outlined-button ?disabled=${this.submitting} @click=${this.resetForm}
                                  >Reset</md-outlined-button
                              >
                              <md-filled-button
                                  form="form"
                                  value="submit"
                                  type="submit"
                                  ?disabled=${this.submitting}
                                  autofocus
                                  >${this.submitting ? 'Saving…' : 'Submit'}</md-filled-button
                              >
                          </div>
                      </div>
                  `
                : html`
                      <md-dialog
                          aria-label="${this.inputData?.title ?? 'Data Entry'}"
                          class="form"
                          style=${dialogSizeStyle(this.inputData?.formDialogSize)}
                          quick
                          ?open=${this.dialogOpen}
                          @cancel=${(event: any) => {
                              event.preventDefault()
                          }}
                          @keydown=${(event: any) => {
                              if (event.key === 'Escape') event.preventDefault()
                          }}
                          @closed=${() => (this.dialogOpen = false)}
                      >
                          <div slot="headline">${this.inputData?.title ?? 'Data Entry'}</div>
                          ${this.renderForm()}
                          <div slot="actions">
                              ${this.renderSubmitError()}
                              ${this.inputData?.deleteButton
                                  ? html`<md-filled-button
                                        class="delete-btn"
                                        form="form"
                                        value="delete"
                                        type="submit"
                                        ?disabled=${this.submitting}
                                        >Delete</md-filled-button
                                    >`
                                  : nothing}
                              <md-outlined-button ?disabled=${this.submitting} @click=${this.resetForm}
                                  >Reset</md-outlined-button
                              >
                              <md-outlined-button ?disabled=${this.submitting} @click=${this.cancelEdit}
                                  >Cancel</md-outlined-button
                              >
                              <md-filled-button
                                  form="form"
                                  value="submit"
                                  type="submit"
                                  ?disabled=${this.submitting}
                                  autofocus
                                  >${this.submitting ? 'Saving…' : 'Submit'}</md-filled-button
                              >
                          </div>
                      </md-dialog>
                  `}
        `
    }

    /**
     * The regular form open button (Floating Action Button off): Material's
     * filled button with the icon and the Label Text. An empty Label Text
     * stays empty on screen; screen readers then get the FAB's name, as the
     * icon is hidden from them. It takes the FAB's background; its label and
     * icon need to read on that, so unset they are black or white by
     * contrast, not the theme's second palette colour the FAB's icon defaults
     * to.
     */
    renderOpenButton(style: ReturnType<typeof openButtonStyle>, ariaLabel: string, surface: string) {
        const { label, size } = style
        const container = String((style.bgColor || this.theme?.theme_object?.color?.[0]) ?? '#9064f7')
        const content = style.color || onColor(opaqueSurface([surface, container]))
        const tokens = [
            `--md-filled-button-container-color: ${container};`,
            ...['label-text', 'icon'].flatMap((part) =>
                ['', 'hover-', 'focus-', 'pressed-'].map(
                    (state) => `--md-filled-button-${state}${part}-color: ${content};`
                )
            ),
            `--md-filled-button-hover-state-layer-color: ${content};`,
            `--md-filled-button-pressed-state-layer-color: ${content};`,
            OPEN_BUTTON_SIZES[size] ?? '',
            style.cornerRadius ? `--md-filled-button-container-shape: ${style.cornerRadius};` : '',
            label ? '' : `--md-filled-button-with-leading-icon-trailing-space: ${ICON_ONLY_TRAILING_SPACE[size]};`
        ]
        return html`<md-filled-button
            class="open-btn"
            type="button"
            has-icon
            aria-label=${label ? nothing : ariaLabel}
            style=${tokens.join(' ')}
            @click=${this.openFormDialog}
            ><md-icon slot="icon">${style.iconName}</md-icon>${label}</md-filled-button
        >`
    }

    renderForm() {
        const fields = this.inputData?.formFields ?? []
        const widths = fieldWidths(fields, fieldLayoutSettings(this.inputData?.fieldLayout).defaultWidth)
        return keyed(
            this.formKey,
            html`
                <form
                    id="form"
                    slot="content"
                    method="dialog"
                    class="form-content"
                    @submit=${this.handleFormSubmit}
                    @input=${this.handleFieldChange}
                    @change=${this.handleFieldChange}
                >
                    ${repeat(
                        fields,
                        (field, i) => i,
                        (field, i) => {
                            if (!field || field.hiddenField) return nothing
                            if (!this.isFieldVisible(field, i)) return nothing
                            if (isSection(field)) return this.renderSection(field)
                            const layout = `w-${widths[i]}${field.newRow === true ? ' new-row' : ''}`
                            switch (field.type) {
                                case 'textfield':
                                    return this.renderTextField(field, i, layout)
                                case 'numberfield':
                                    return this.renderNumberField(field, i, layout)
                                case 'datetime':
                                    return this.renderDateTimeField(field, i, layout)
                                case 'textarea':
                                    return this.renderTextArea(field, i, layout)
                                case 'dropdown':
                                    return this.renderDropdown(field, i, layout)
                                case 'checkbox':
                                    return this.renderCheckbox(field, i, layout)
                                case 'file':
                                    return this.renderFileField(field, i, layout)
                                case 'secret':
                                    return this.renderSecretField(field, i, layout)
                                case 'color':
                                    return this.renderColorField(field, i, layout)
                            }
                        }
                    )}
                </form>
            `
        )
    }
}

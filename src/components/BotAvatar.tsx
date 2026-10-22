import { useEffect, useId, useRef, type CSSProperties } from 'react'
import { hash, type AvatarStyle, type Mood } from '../agent/avatar'

/*
 * A bot's face: an SVG robot tinted with the bot's color, animated by its mood.
 * Idle bots float, blink, and look toward the pointer; working bots scan;
 * thinking bots show thought dots; waiting bots raise a "?"; finished bots hop.
 * All motion lives in CSS (see .av-* in index.css) and is turned off under
 * prefers-reduced-motion, leaving the mood readable from the face alone.
 */

// One shared pointer listener moves the eyes of every mounted avatar.
const watchers = new Set<SVGSVGElement>()
let frame = 0
let pointer: { x: number; y: number } | null = null

function look() {
  frame = 0
  if (!pointer) return
  for (const el of watchers) {
    const r = el.getBoundingClientRect()
    if (!r.width) continue
    const dx = pointer.x - (r.left + r.width / 2)
    const dy = pointer.y - (r.top + r.height / 2)
    const dist = Math.hypot(dx, dy) || 1
    // Eyes move at most 4 units, less when the pointer is close.
    const reach = Math.min(4, dist / 40)
    el.style.setProperty('--lx', ((dx / dist) * reach).toFixed(2))
    el.style.setProperty('--ly', ((dy / dist) * reach * 0.7).toFixed(2))
  }
}

function onPointer(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY }
  if (!frame) frame = requestAnimationFrame(look)
}

function watch(el: SVGSVGElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}
  if (!watchers.size) window.addEventListener('pointermove', onPointer, { passive: true })
  watchers.add(el)
  return () => {
    watchers.delete(el)
    if (!watchers.size) window.removeEventListener('pointermove', onPointer)
  }
}

export function BotAvatar({ id, color, look: style, mood = 'idle', size = 40, label }: {
  id: string
  color: string
  look: AvatarStyle
  mood?: Mood
  size?: number
  label?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const uid = useId().replace(/:/g, '')
  useEffect(() => (ref.current ? watch(ref.current) : undefined), [])

  const h = hash(id)
  // Each bot blinks and floats on its own rhythm.
  const vars = {
    '--bot': color,
    '--blink-delay': `${(h % 4000) / 1000}s`,
    '--float-delay': `${((h >>> 8) % 3000) / -1000}s`,
  } as CSSProperties

  const eyes = mood === 'happy' ? 'happy' : style.eyes
  const shell = `url(#shell-${uid})`

  return (
    <svg
      ref={ref}
      className={`av av-${mood}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={vars}
      role="img"
      aria-label={label ?? `Bot avatar, ${mood}`}
    >
      <defs>
        <linearGradient id={`shell-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="av-stop-light" />
          <stop offset="1" className="av-stop-dark" />
        </linearGradient>
        <radialGradient id={`glow-${uid}`}>
          <stop offset="0" className="av-stop-glow" />
          <stop offset="1" className="av-stop-clear" />
        </radialGradient>
      </defs>

      <ellipse className="av-shadow" cx="50" cy="95" rx="24" ry="3.5" />

      <g className="av-body">
        {/* The top: antennas or ear bolts */}
        {style.top === 'single' && (
          <g className="av-top">
            <line x1="50" y1="30" x2="50" y2="13" className="av-stem" />
            <circle cx="50" cy="11" r="9" fill={`url(#glow-${uid})`} className="av-halo" />
            <circle cx="50" cy="11" r="4.5" className="av-ball" />
          </g>
        )}
        {style.top === 'double' && (
          <g className="av-top">
            <line x1="38" y1="30" x2="31" y2="15" className="av-stem" />
            <line x1="62" y1="30" x2="69" y2="15" className="av-stem" />
            <circle cx="31" cy="13" r="8" fill={`url(#glow-${uid})`} className="av-halo" />
            <circle cx="69" cy="13" r="8" fill={`url(#glow-${uid})`} className="av-halo" />
            <circle cx="31" cy="13" r="3.8" className="av-ball" />
            <circle cx="69" cy="13" r="3.8" className="av-ball av-ball-2" />
          </g>
        )}
        {style.top === 'ears' && (
          <g>
            <rect x="6" y="50" width="10" height="18" rx="4" fill={shell} />
            <rect x="84" y="50" width="10" height="18" rx="4" fill={shell} />
          </g>
        )}

        {/* The head */}
        {style.shape === 'round' && <circle cx="50" cy="60" r="34" fill={shell} />}
        {style.shape === 'square' && <rect x="16" y="28" width="68" height="64" rx="18" fill={shell} />}
        {style.shape === 'tv' && (
          <g>
            <rect x="12" y="30" width="76" height="58" rx="11" fill={shell} />
            <rect x="30" y="86" width="9" height="7" rx="2" fill={shell} />
            <rect x="61" y="86" width="9" height="7" rx="2" fill={shell} />
          </g>
        )}
        {style.shape === 'blob' && (
          <path d="M50 26 C78 26 86 38 86 60 C86 84 74 93 50 93 C26 93 14 84 14 60 C14 38 22 26 50 26 Z" fill={shell} />
        )}
        <ellipse cx="36" cy="40" rx="11" ry="5" className="av-shine" />

        {/* The face screen */}
        <rect x="25" y="44" width="50" height="34" rx="13" className="av-screen" />
        <g className="av-look">
          <g className="av-eyes">
            {mood === 'error' ? (
              <g className="av-x">
                <path d="M35 53 l8 8 M43 53 l-8 8" />
                <path d="M57 53 l8 8 M65 53 l-8 8" />
              </g>
            ) : eyes === 'dot' ? (
              <>
                <circle cx="39" cy="58" r="4.6" className="av-eye" />
                <circle cx="61" cy="58" r="4.6" className="av-eye" />
              </>
            ) : eyes === 'oval' ? (
              <>
                <ellipse cx="39" cy="58" rx="3.6" ry="6" className="av-eye" />
                <ellipse cx="61" cy="58" rx="3.6" ry="6" className="av-eye" />
              </>
            ) : eyes === 'visor' ? (
              <g>
                <rect x="31" y="54" width="38" height="8" rx="4" className="av-eye av-visor" />
                <rect x="33" y="55.5" width="8" height="5" rx="2.5" className="av-scan" />
              </g>
            ) : (
              <g className="av-arcs">
                <path d="M33 60 Q39 51 45 60" />
                <path d="M55 60 Q61 51 67 60" />
              </g>
            )}
          </g>
        </g>
        {mood === 'happy' ? (
          <path d="M43 69 Q50 75 57 69" className="av-smile" />
        ) : mood === 'error' ? (
          <path d="M43 72 Q50 67 57 72" className="av-smile" />
        ) : (
          <rect x="44" y="68" width="12" height="3.2" rx="1.6" className="av-mouth" />
        )}
        <circle cx="31" cy="70" r="3.2" className="av-cheek" />
        <circle cx="69" cy="70" r="3.2" className="av-cheek" />
      </g>

      {/* Mood props */}
      {mood === 'thinking' && (
        <g className="av-thought">
          <circle cx="78" cy="22" r="3" />
          <circle cx="86" cy="13" r="4" />
          <circle cx="95" cy="4" r="5" />
        </g>
      )}
      {mood === 'waiting' && (
        <g className="av-question">
          <circle cx="84" cy="16" r="12" />
          <text x="84" y="21.5" textAnchor="middle">
            ?
          </text>
        </g>
      )}
      {mood === 'happy' && (
        <g className="av-sparkles">
          <path d="M12 20 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />
          <path d="M86 26 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5z" />
        </g>
      )}
    </svg>
  )
}

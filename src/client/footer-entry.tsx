/**
 * The sidebar-foot trigger: a phone icon (with label in wide mode) that opens
 * the loopback management page as an in-page modal overlay (a fixed layer
 * carrying `/m/` in an iframe), with a secondary affordance to open it in a
 * full browser tab. Styling rides the official `--dsw-*` tokens with literal
 * fallbacks so the entry blends with the settings row beside it.
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

/** Shared button chrome; wide renders a labelled row, rail a centered icon. */
const base: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-text-secondary, #9ba1ab)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  padding: '6px 10px',
  borderRadius: 8,
}

const wideStyle: CSSProperties = { ...base, width: '100%', justifyContent: 'flex-start' }
const railStyle: CSSProperties = { ...base, justifyContent: 'center', width: '100%' }

const iconStyle: CSSProperties = { flex: '0 0 auto' }

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9990,
  background: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(940px, 94vw)',
  height: 'min(680px, 86vh)',
  borderRadius: 12,
  overflow: 'hidden',
  background: 'var(--dsw-specific-sidebar-fill, #1e2126)',
  color: 'var(--dsw-alias-label-primary, #e6e8eb)',
  boxShadow: '0 12px 48px rgba(0, 0, 0, 0.4)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid rgba(127, 127, 127, 0.25)',
  flex: 'none',
}

const titleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }

const headerButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  padding: '5px 10px',
  borderRadius: 7,
}

const iframeStyle: CSSProperties = {
  flex: 1,
  width: '100%',
  border: 'none',
  background: 'var(--dsw-specific-sidebar-fill, #1e2126)',
}

/** The management page carried in a viewport-fixed overlay. */
function GatewayModal({ onClose }: { onClose: () => void }): JSX.Element {
  // Escape closes while the parent document holds focus (interactions inside
  // the iframe keep focus there; the close button and backdrop cover those).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div style={backdropStyle} onClick={onClose} role="presentation">
      <div
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label="手机 App 配对与管理"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div style={headerStyle}>
          <span style={titleStyle}>手机 App 配对与管理</span>
          <a
            href="/m/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...headerButtonStyle, textDecoration: 'none', color: 'inherit' }}
            title="在浏览器新标签页打开"
          >
            新标签页
          </a>
          <button type="button" style={headerButtonStyle} onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>
        <iframe src="/m/" title="手机 App 配对与管理" style={iframeStyle} />
      </div>
    </div>
  )
}

/** @param props - the footer-action owner share: `wide` is the sidebar column state. */
export function FooterGatewayEntry({ wide }: { wide: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        style={wide ? wideStyle : railStyle}
        title="手机 App 配对与管理"
        aria-label="手机 App 配对与管理"
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'var(--dsw-hover, rgba(127, 127, 127, 0.14))'
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent'
        }}
        onClick={() => { setOpen(true) }}
      >
        <svg
          style={iconStyle}
          width={17}
          height={17}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
          <path d="M10.5 18.5h3" />
        </svg>
        {wide ? <span>手机</span> : null}
      </button>
      {open ? <GatewayModal onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

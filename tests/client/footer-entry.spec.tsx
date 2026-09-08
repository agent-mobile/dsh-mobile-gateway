/** Footer-entry component shape: wide row vs rail icon (server-rendered, no DOM). */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { FooterGatewayEntry } from '../../src/client/footer-entry.tsx'

describe('FooterGatewayEntry', () => {
  it('renders a labelled row in wide mode', () => {
    const html = renderToString(<FooterGatewayEntry wide />)
    expect(html).toContain('<button')
    expect(html).toContain('手机')
    expect(html).toContain('aria-label="手机 App 配对与管理"')
  })

  it('renders the icon only in rail mode', () => {
    const html = renderToString(<FooterGatewayEntry wide={false} />)
    expect(html).toContain('<button')
    expect(html).toContain('<svg')
    expect(html).not.toContain('>手机<')
  })

  it('carries no modal overlay while closed', () => {
    const html = renderToString(<FooterGatewayEntry wide />)
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('role="dialog"')
  })
})

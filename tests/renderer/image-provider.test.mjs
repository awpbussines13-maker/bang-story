import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()]
})
try {
  const { ModelSection } = await server.ssrLoadModule('/src/renderer/src/pages/project/ModelSection.tsx')
  const settings = { imageProvider: '9router', nineRouterImageModel: 'ag/gemini-3.1-flash-image' }
  const project = { aspectRatio: '16:9', imageModel: 'marketing-studio/image/sunburst', videoModel: 'kling-video/v3.0/std/image-to-video' }
  const render = (override) => renderToStaticMarkup(createElement(ModelSection, {
    project: { ...project, ...override }, settings, clipCount: 11, perClip: 5,
    onChange() {}, onOpenSettings() {}
  }))
  await test('inherited 9Router shows configured image model instead of Higgsfield picker', () => {
    const html = render()
    assert.ok(html.includes(settings.nineRouterImageModel), 'configured 9Router model must be visible')
    assert.ok(!html.includes('GPT Image 2.5'), 'inactive Higgsfield image model must be hidden')
    assert.ok(html.includes('Video AI · Higgsfield'), 'video provider remains explicit')
  })
  await test('null project provider inherits app default', () => {
    assert.ok(render({ imageProvider: null }).includes(settings.nineRouterImageModel))
  })
  await test('explicit project provider takes priority over app default', () => {
    const html = render({ imageProvider: 'higgsfield' })
    assert.ok(html.includes('GPT Image 2.5'))
    assert.ok(!html.includes(settings.nineRouterImageModel))
    assert.ok(html.includes('Ikuti pengaturan'), 'user can clear project override')
  })
  await test('explicit 9Router remains active when app default is Higgsfield', () => {
    settings.imageProvider = 'higgsfield'
    assert.ok(render({ imageProvider: '9router' }).includes(settings.nineRouterImageModel))
    assert.ok(render().includes('GPT Image 2.5'))
  })
} finally {
  await server.close()
}

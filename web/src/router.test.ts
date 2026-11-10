import { describe, expect, test } from 'bun:test'
import { matchRoute, paths } from './router'

describe('routes', () => {
  test('home, the list, one announcement and the editor; anything else is not found', () => {
    expect(matchRoute('/')).toEqual({ name: 'home' })
    expect(matchRoute('/announcements')).toEqual({ name: 'announcements' })
    expect(matchRoute('/announcements/')).toEqual({ name: 'announcements' })
    expect(matchRoute('/announcements/01JC0ABCDEF')).toEqual({ name: 'announcement', id: '01JC0ABCDEF' })
    expect(matchRoute('/announcements/new')).toEqual({ name: 'newAnnouncement' })
    expect(matchRoute('/announcements/01JC0ABCDEF/edit')).toEqual({ name: 'editAnnouncement', id: '01JC0ABCDEF' })
    expect(matchRoute('/announcements/new/edit')).toEqual({ name: 'notFound' })
    expect(matchRoute('/settings')).toEqual({ name: 'notFound' })
    expect(matchRoute('/announcements/%E0%A4%A')).toEqual({ name: 'notFound' })
  })

  test('paths build the URLs the routes match', () => {
    expect(matchRoute(paths.announcement('01A'))).toEqual({ name: 'announcement', id: '01A' })
    expect(matchRoute(paths.editAnnouncement('01A'))).toEqual({ name: 'editAnnouncement', id: '01A' })
    expect(matchRoute(paths.newAnnouncement)).toEqual({ name: 'newAnnouncement' })
  })
})

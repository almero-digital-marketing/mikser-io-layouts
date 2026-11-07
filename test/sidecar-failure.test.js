// Where a failing sidecar's error came from, in the project's own terms.
//
// A sidecar that throws is now reported and survived rather than crashing the
// process, which means nothing prints its stack any more. And the message
// alone rarely says where: the case this was built for read
// `SHARE_IMAGE_DEFAULT is not defined` — a const, in a helper three imports
// below the sidecar the line named. So the line carries the first frame that
// is the project's own code. The end-to-end behaviour (the cycle completing,
// the watcher surviving, the next save recovering) is covered by
// mikser-io/test/scenarios/watch-cycle-failure.test.js, which needs a real
// watcher.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectFrame } from '../lib/assembly.js'

const stackOf = (...frames) => ['ReferenceError: X is not defined', ...frames.map(f => `    at ${f}`)].join('\n')

describe('projectFrame', () => {
    const working = '/srv/site'

    it('names the first frame in the project, relative, without the reload stamp', () => {
        const err = { stack: stackOf(
            'pageContext (file:///srv/site/layouts/lib/context.js?stamp=6a24270efaf6c0dc:1:49)',
            'load (file:///srv/site/layouts/page.js?stamp=6a24270efaf6c0dc:2:49)',
        ) }
        assert.equal(projectFrame(err, working), 'layouts/lib/context.js:1:49')
    })

    it('skips dependencies, including those installed inside the project', () => {
        // A frame in a dependency says where it noticed, not what to fix.
        const err = { stack: stackOf(
            'parse (file:///srv/site/node_modules/yaml/dist/index.js:10:3)',
            'file:///home/me/mikser-io-layouts/lib/assembly.js:343:39',
            'load (file:///srv/site/layouts/page.js:2:5)',
        ) }
        assert.equal(projectFrame(err, working), 'layouts/page.js:2:5')
    })

    it('reads an anonymous frame, which has no parentheses', () => {
        const err = { stack: stackOf('file:///srv/site/layouts/page.js?stamp=abc:7:1') }
        assert.equal(projectFrame(err, working), 'layouts/page.js:7:1')
    })

    it('does not mistake a sibling folder sharing the prefix for the project', () => {
        const err = { stack: stackOf('x (file:///srv/site-old/layouts/page.js:1:1)') }
        assert.equal(projectFrame(err, working), null)
    })

    it('decodes what the file URL encoded', () => {
        const err = { stack: stackOf('x (file:///srv/my%20site/layouts/page.js:3:4)') }
        assert.equal(projectFrame(err, '/srv/my site'), 'layouts/page.js:3:4')
    })

    it('answers null rather than guessing when there is nothing to name', () => {
        assert.equal(projectFrame({ stack: stackOf('node:internal/x:1:1') }, working), null)
        assert.equal(projectFrame(new Error('x'), null), null)
        assert.equal(projectFrame('a string was thrown', working), null)
    })
})

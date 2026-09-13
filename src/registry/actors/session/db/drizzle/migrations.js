import m0000 from './0000_old_luckman.sql' with { type: 'text' }
import m0001 from './0001_tidy_lockjaw.sql' with { type: 'text' }
import m0002 from './0002_violet_blindfold.sql' with { type: 'text' }
import m0003 from './0003_lyrical_morlocks.sql' with { type: 'text' }
import m0004 from './0004_outstanding_bullseye.sql' with { type: 'text' }
import m0005 from './0005_wealthy_silverclaw.sql' with { type: 'text' }
import journal from './meta/_journal.json' with { type: 'json' }

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
  },
}

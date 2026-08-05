/**
 * Entry point. Starts the database, the CRM client, WhatsApp, the pipeline, the
 * retry worker, and the admin panel — then shuts them down cleanly.
 *
 * Order matters: the admin panel comes up before WhatsApp connects, so the QR or
 * pairing code has somewhere to appear. WhatsApp failing must never stop the
 * panel — that is where you go to fix it.
 */
const { config, validate } = require('./config');
const logger = require('./logger');
const db = require('./db');
const repo = require('./db/repositories');
const { CrmClient } = require('./crm/client');
const { WhatsAppClient } = require('./whatsapp/client');
const { Orchestrator } = require('./pipeline/orchestrator');
const { RetryWorker } = require('./pipeline/worker');
const { createServer } = require('./api/server');

async function main() {
  const { fatal, warnings } = validate();

  for (const warning of warnings) logger.warn(warning);

  if (fatal.length) {
    for (const problem of fatal) logger.error(problem);
    logger.error('Refusing to start. Fix the above in .env and try again.');
    process.exit(1);
  }

  db.init();

  // Mirror logs into the database so the panel can show them after a restart.
  logger.subscribe(({ level, message }) => {
    try {
      repo.logs.record(level, message, config.logging.retainInDb);
    } catch {
      // Never let a logging failure break the thing being logged.
    }
  });

  const crm = new CrmClient();
  const whatsapp = new WhatsAppClient();
  const orchestrator = new Orchestrator({ crm, whatsapp });
  const worker = new RetryWorker({ orchestrator });

  if (crm.configured) {
    try {
      const me = await crm.whoami();
      await crm.loadUsers();
      logger.info(`CRM connected as ${me.email} (${me.company_name || 'unknown company'})`);
    } catch (error) {
      // Not fatal: leads are still captured and retried once the CRM returns.
      logger.error(`CRM unreachable at startup: ${error.message}`);
      logger.warn('Leads will be captured and retried until it is back.');
    }
  } else {
    logger.warn('CRM is not configured — leads will be captured but not sent.');
  }

  // Route every group message through the pipeline. The raw message is passed
  // through so replies can quote it.
  whatsapp.on('message', (message, raw) => orchestrator.handle(message, raw));

  whatsapp.on('ready', async () => {
    try {
      const groups = await whatsapp.listGroups();
      for (const group of groups) repo.groups.upsert(group.id, group.name);

      const active = repo.groups.active();
      logger.info(`In ${groups.length} group(s); monitoring ${active.length}`);
      for (const group of active) {
        logger.info(`  monitoring: ${group.name} (${group.purpose}, `
          + `sending ${group.send_enabled ? 'on' : 'off'})`);
      }
      if (active.length === 0) {
        logger.warn('No groups are being monitored yet — choose one in the admin panel.');
      }
    } catch (error) {
      logger.error(`Could not list groups: ${error.message}`);
    }
  });

  const server = createServer({ whatsapp, crm, orchestrator });
  server.listen(config.server.port, config.server.host, () => {
    logger.info(`Admin panel on http://${config.server.host}:${config.server.port}`);
  });

  worker.start();

  // WhatsApp last, and non-blocking: if it fails, the panel is still up to fix it.
  whatsapp.connect({ pairingPhone: process.env.WA_PAIRING_PHONE }).catch((error) => {
    logger.error(`WhatsApp failed to start: ${error.message}`);
    logger.warn('The admin panel is still running.');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — shutting down`);

    worker.stop();
    await whatsapp.disconnect().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash that takes the process down loses the WhatsApp connection, so log
  // loudly and keep running wherever it is safe to.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  });
}

main().catch((error) => {
  logger.error(`Fatal: ${error.stack || error.message}`);
  process.exit(1);
});

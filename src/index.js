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
const { DailyScheduler } = require('./pipeline/scheduler');
const { buildMorningMessage, buildStageReport } = require('./pipeline/digest');
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
      // Refuses to continue if the key resolves to a different company: the same
      // email exists in both tenants as different people, so a mis-set key would
      // assign leads to the wrong person entirely.
      const me = await crm.verifyTenant();
      await crm.loadUsers();
      logger.info(`CRM connected as ${me.email} — ${me.company_name} (${me.company_id})`);
    } catch (error) {
      if (/Wrong CRM tenant/.test(error.message)) {
        logger.error(error.message);
        logger.error('Refusing to start rather than write to the wrong company.');
        process.exit(1);
      }
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

  // A reconnect means there was a window where WhatsApp may have pushed messages
  // to a connection that was no longer listening. It will not tell us what we
  // missed, so we ask the phone to replay from the last message we recorded.
  whatsapp.on('gap', async ({ seconds }) => {
    for (const group of repo.groups.active()) {
      if (!group.last_message_id) continue;
      await whatsapp.requestHistory({
        waGroupId: group.wa_group_id,
        lastMessageId: group.last_message_id,
        lastMessageTs: group.last_message_ts,
        lastFromMe: Boolean(group.last_message_from_me)
      }, seconds > 120 ? 100 : 30);
    }
  });

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

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${config.server.port} is already in use.`);
      logger.error('Another copy of the bot is probably running. Stop it first —');
      logger.error(`  lsof -ti:${config.server.port} | xargs kill`);
      logger.error('Two copies must never run against the same WhatsApp number.');
    } else {
      logger.error(`Server error: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.server.port, config.server.host, () => {
    logger.info(`Admin panel on http://${config.server.host}:${config.server.port}`);
  });

  worker.start();

  // Yesterday's summary, posted into each monitored group that has replies on.
  // Nothing is posted on a day with no leads — a summary reading "0" every
  // morning trains people to ignore the bot.
  const digest = new DailyScheduler({
    name: 'daily-summary',
    at: process.env.DAILY_SUMMARY_AT || '09:00',
    run: async () => {
      if (repo.settings.get('sending_paused') === 'true') {
        logger.info('Sending is paused — skipping the daily summary');
        return;
      }

      const summary = await buildMorningMessage(crm);
      if (!summary) {
        logger.info('Nothing to report this morning — no message posted');
        return;
      }

      for (const group of repo.groups.active()) {
        if (!group.send_enabled || group.purpose !== 'inhouse') continue;
        await whatsapp.reply({ groupId: group.wa_group_id, text: summary.text });
      }

      logger.info(`Morning message posted: ${summary.leads} lead(s), `
        + `${summary.untouched} untouched, ${summary.due} follow-up(s)`);
    }
  });
  digest.start();

  // End-of-day login and PF report. Posted whether or not anything happened —
  // a report that only appears on good days is not a report.
  const stageReport = new DailyScheduler({
    name: 'stage-report',
    at: config.stageReport.at,
    run: async () => {
      if (repo.settings.get('sending_paused') === 'true') {
        logger.info('Sending is paused — skipping the stage report');
        return;
      }

      // Resolved from the live user list each time, so a renamed or re-created
      // CRM account does not silently drop someone from the report.
      const agents = config.stageReport.agents
        .map((email) => [...(crm.users?.values() || [])]
          .find((u) => u.email.toLowerCase() === email))
        .filter(Boolean)
        .map((u) => ({ id: u.id, name: u.full_name }));

      const missing = config.stageReport.agents.length - agents.length;
      if (missing > 0) {
        logger.warn(`${missing} configured report agent(s) not found in the CRM`);
      }
      if (!agents.length) {
        logger.error('No report agents resolved — stage report skipped');
        return;
      }

      const report = await buildStageReport(crm, agents);
      if (!report) return;

      for (const group of repo.groups.active()) {
        if (!group.send_enabled || group.purpose !== 'inhouse') continue;
        await whatsapp.reply({ groupId: group.wa_group_id, text: report.text });
      }

      logger.info(`Stage report posted: ${report.totals.logged_in} login(s), `
        + `${report.totals.pf_paid} PF`);
    }
  });
  stageReport.start();

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
    digest.stop();
    stageReport.stop();
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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { AuthUser, ExecApprovalDecision, ResearchDeliveryTarget } from '@ocp/domain';
import {
  DockerExecConnector,
  GatewayNotFoundError,
  PersistentGatewayConnector,
} from '@ocp/gateway-client';
import type { GatewayCallFailure, GatewayCallResult } from '@ocp/gateway-client';
import type { ApiConfig } from './config.js';
import { login, logout, resolveUser } from './auth.js';
import { hitRateLimit } from './rate-limit.js';
import { FleetService } from './services/fleet-service.js';
import { FleetSnapshotStore } from './services/fleet-snapshot-store.js';
import type { FleetSnapshot } from './services/fleet-snapshot-store.js';
import { AuditStore } from './services/audit-store.js';
import { ResearchService } from './services/research-service.js';
import { ResearchTracker } from './services/research-tracker.js';
import { ApprovalService } from './services/approval-service.js';
import { SessionService } from './services/session-service.js';
import { SessionHub } from './services/session-hub.js';
import { deriveTitleFromHistory, SessionTitleStore } from './services/session-titles.js';
import { CronService } from './services/cron-service.js';
import { ConfigService } from './services/config-service.js';
import { SecurityService } from './services/security-service.js';
import { ExchangeService } from './services/exchange-service.js';

type Variables = {
  user: AuthUser;
};

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function hasRole(user: AuthUser, role: string): boolean {
  return user.roles.includes(role) || user.roles.includes('admin');
}

export function createApp(config: ApiConfig) {
  const app = new Hono<{ Variables: Variables }>();
  // Gateway RPC latency used to dominate every page load, so it stays
  // observable. Set CONTROL_PLANE_RPC_LOG=off to silence.
  const onCall = config.rpcLog
    ? (r: GatewayCallResult | GatewayCallFailure) => {
        const outcome = r.ok ? 'ok' : `FAIL ${r.error}`;
        console.log(`[rpc] ${r.gatewayId} ${r.method} ${r.durationMs}ms ${outcome}`);
      }
    : undefined;

  // Declared before the connector because the connector's event callback feeds
  // them, and events can arrive as soon as the first link is up.
  // Definite-assignment: both are constructed below, before any link is opened
  // (the connector only dials on start()). The `?.` at the callback keeps that
  // ordering assumption from becoming a crash if it ever stops holding.
  let snapshots!: FleetSnapshotStore;
  let sessionHub!: SessionHub;

  const persistent =
    config.connectorMode === 'persistent'
      ? new PersistentGatewayConnector({
          fleetPath: config.fleetPath,
          identityPath: config.deviceIdentityPath,
          secretsDir: config.secretsDir,
          onCall,
          logger: (message) => console.log(message),
          onStateChange: (status) => {
            console.log(
              `[gateway] ${status.gatewayId} -> ${status.state}${
                status.lastError ? ` (${status.lastError})` : ''
              }`
            );
          },
          onEvent: (event) => {
            // The whole point of the persistent link: gateway state changes
            // reach the UI because the gateway said so, not because a timer
            // fired. Both consumers coalesce internally.
            snapshots?.touchGateway(event.gatewayId);
            sessionHub?.handleEvent(event);
          },
        })
      : null;

  const connector =
    persistent ??
    new DockerExecConnector({
      fleetPath: config.fleetPath,
      onCall,
    });

  const fleet = new FleetService(connector);
  snapshots = new FleetSnapshotStore(fleet, {
    refreshIntervalMs: config.snapshotRefreshMs,
  });
  const audit = new AuditStore(config.auditPath);
  const research = new ResearchService({ enclaveRoot: config.enclaveRoot });
  const approvals = new ApprovalService(connector, research, audit);
  const sessions = new SessionService(connector, audit);
  sessionHub = new SessionHub(sessions);
  const sessionTitles = new SessionTitleStore(config.sessionTitlesPath);
  const cron = new CronService(connector, audit);
  const configs = new ConfigService(
    connector,
    audit,
    config.configVersionsPath,
    config.monorepoRoot
  );
  const security = new SecurityService(config.monorepoRoot);
  const exchange = new ExchangeService(config.enclaveRoot);

  /**
   * Which session a ready brief is announced in.
   *
   * The request file carries only `query` and `topic_id` — a closed schema, and
   * widening it to smuggle a session key through would push bytes `main` chose
   * across the very boundary research-request-mover.sh exists to meter. So the
   * association is made on this side instead: the most recently active session
   * on the research gateway, read from the snapshot the fleet sweep already
   * maintains (sorted updatedAt-descending in FleetService), at delivery time.
   * In practice that is the session the operator was in when they asked, and
   * POST /api/research-requests/:topicId/deliver overrides it when it is not.
   */
  const resolveResearchTarget = (): ResearchDeliveryTarget | null => {
    const detail = snapshots
      .current()
      ?.details.find((d) => d.status.gatewayId === config.researchGatewayId);
    const session = detail?.sessions[0];
    if (!session) return null;
    return { gatewayId: config.researchGatewayId, sessionKey: session.key };
  };

  const researchTracker = new ResearchTracker(
    research,
    sessions,
    audit,
    {
      storePath: config.researchTrackingPath,
      pollIntervalMs: config.researchPollMs,
      staleAfterMs: config.researchStaleAfterMs,
      retentionMs: config.researchRetentionMs,
      briefContainerDir: config.researchBriefContainerDir,
      briefFlaggedContainerDir: config.researchBriefFlaggedContainerDir,
      deliverToSession: config.researchDeliverToSession,
      autoArchive: config.researchAutoArchive,
      gatewayId: config.researchGatewayId,
    },
    resolveResearchTarget
  );

  app.use(
    '*',
    cors({
      origin: config.corsOrigin,
      credentials: true,
      allowHeaders: ['Authorization', 'Content-Type'],
    })
  );

  // Basic security headers
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'openclaw-control-plane-api',
      authDisabled: config.authDisabled,
      phase: '5-10',
      connector: config.connectorMode,
      enclaveRoot: config.enclaveRoot,
      monorepoRoot: config.monorepoRoot,
      realtime: persistent ? 'gateway-events' : 'sse-poll',
      // Surfaces an unpaired or flapping gateway without needing the logs;
      // `state: "unpaired"` is the one condition an operator must act on.
      links: persistent?.linkStatuses() ?? null,
      deviceId: persistent?.deviceId ?? null,
    })
  );

  app.post('/api/auth/login', async (c) => {
    if (config.authDisabled) {
      return c.json({ token: 'dev', user: resolveUser(config, null) });
    }
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const limit = hitRateLimit(`login:${ip}`, config.loginMaxAttempts, config.loginWindowMs);
    if (!limit.allowed) {
      audit.append({
        type: 'auth.login.rate_limited',
        actorType: 'system',
        actorId: ip,
        gatewayId: null,
        approvalId: null,
        sessionKey: null,
        outcome: 'denied',
        summary: `Login rate limited for ${ip}`,
      });
      return c.json(
        { error: 'Too many login attempts', code: 'rate_limited', retryAfterMs: limit.retryAfterMs },
        429
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const result = login(config, body.username ?? '', body.password ?? '');
    if (!result.ok) {
      audit.append({
        type: 'auth.login.failed',
        actorType: 'user',
        actorId: body.username ?? null,
        gatewayId: null,
        approvalId: null,
        sessionKey: null,
        outcome: 'denied',
        summary: `Failed login for ${body.username ?? 'unknown'}`,
      });
      return c.json({ error: 'Invalid credentials', code: result.code }, 401);
    }
    audit.append({
      type: 'auth.login',
      actorType: 'user',
      actorId: result.user.username,
      gatewayId: null,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `User ${result.user.username} logged in`,
    });
    return c.json({ token: result.token, user: result.user });
  });

  app.post('/api/auth/logout', async (c) => {
    logout(bearerToken(c.req.header('authorization')));
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => {
    const user = resolveUser(config, bearerToken(c.req.header('authorization')));
    if (!user) return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    return c.json({ user });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/auth/login') {
      return next();
    }
    const user = resolveUser(config, bearerToken(c.req.header('authorization')));
    if (!user) {
      return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }
    c.set('user', user);
    await next();
  });

  // ─── Fleet (Phase 1–2) ───────────────────────────────────────────────────

  app.get('/api/gateways', async (c) => {
    const gateways = fleet.listGateways();
    const snap = await snapshots.ready();
    const byId = new Map(snap.details.map((d) => [d.status.gatewayId, d.status]));
    return c.json({
      items: gateways.map((g) => ({
        ...g,
        live: byId.get(g.id) ?? null,
      })),
      generatedAt: snap.generatedAt,
    });
  });

  app.get('/api/gateways/:id', async (c) => {
    try {
      const gw = fleet.getGateway(c.req.param('id'));
      const snap = await snapshots.ready();
      const live = snap.details.find((d) => d.status.gatewayId === gw.id)?.status ?? null;
      return c.json({ gateway: gw, live, generatedAt: snap.generatedAt });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/gateways/:id/status', async (c) => {
    try {
      const live = await fleet.statusFor(c.req.param('id'));
      return c.json({ live });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/agents', async (c) => {
    try {
      const gatewayId = c.req.query('gatewayId') || undefined;
      const snap = await snapshots.ready();
      const items = snap.details
        .filter((d) => !gatewayId || d.status.gatewayId === gatewayId)
        .flatMap((d) => d.agents);
      return c.json({ items, generatedAt: snap.generatedAt });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/gateways/:id/agents', async (c) => {
    try {
      const gatewayId = c.req.param('id');
      const snap = await snapshots.ready();
      const items = snap.details.find((d) => d.status.gatewayId === gatewayId)?.agents ?? [];
      return c.json({ items, generatedAt: snap.generatedAt });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/gateways/:id/agents/:agentId', async (c) => {
    try {
      const gatewayId = c.req.param('id');
      const agentId = c.req.param('agentId');
      // All three collections come from the same sweep. This used to be three
      // sequential Gateway round trips on every open of an agent page.
      const snap = await snapshots.ready();
      const detail = snap.details.find((d) => d.status.gatewayId === gatewayId);

      const agent = detail?.agents.find((a) => a.id === agentId) ?? null;
      if (!agent) return c.json({ error: 'Agent not found', code: 'agent_not_found' }, 404);

      const agentSessions = (detail?.sessions ?? []).filter(
        (s) => s.agentId === agent.id || s.key.includes(`agent:${agent.id}:`)
      );
      const agentCron = (detail?.cronJobs ?? []).filter(
        (j) => j.agentId === agent.id || (j.declarationKey || '').startsWith(`${agent.id}:`)
      );
      return c.json({
        agent,
        sessions: agentSessions.slice(0, 50).map((s) => ({
          ...s,
          title: sessionTitles.resolve(s.gatewayId, s.key, s.displayName),
        })),
        cronJobs: agentCron,
        generatedAt: snap.generatedAt,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/gateways/:id/sessions', async (c) => {
    try {
      const gatewayId = c.req.param('id');
      const agentId = c.req.query('agentId') || undefined;
      const snap = await snapshots.ready();
      const all = snap.details.find((d) => d.status.gatewayId === gatewayId)?.sessions ?? [];
      const filtered = agentId
        ? all.filter((s) => s.agentId === agentId || s.key.includes(`agent:${agentId}:`))
        : all;
      const items = filtered.map((s) => ({
        ...s,
        title: sessionTitles.resolve(gatewayId, s.key, s.displayName),
        titleSource: sessionTitles.get(gatewayId, s.key)?.source ?? null,
      }));
      return c.json({ items, generatedAt: snap.generatedAt });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/gateways/:id/sessions/:sessionKey/history', async (c) => {
    try {
      const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
      const limit = Number(c.req.query('limit') ?? '40');
      const history = await fleet.getChatHistory(c.req.param('id'), sessionKey, limit);
      return c.json({ sessionKey, history });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ─── Phase 3: session detail, chat send, timeline ────────────────────────

  /**
   * The name to show for a conversation, backfilling it from the transcript the
   * first time an untitled one is opened.
   *
   * Sessions created before the title store existed have no stored name, and
   * the gateway only knows them as "openclaw-control-plane" (the client that
   * opened them). The transcript is already in hand here, so deriving the title
   * from the opening message costs nothing and is done once — the derived title
   * is written back, so later reads take the stored path.
   */
  const titleForDetail = (gatewayId: string, sessionKey: string, detail: { history?: unknown }): string => {
    const stored = sessionTitles.get(gatewayId, sessionKey);
    if (stored) return stored.title;
    const derived = deriveTitleFromHistory(detail.history);
    if (derived) return sessionTitles.set(gatewayId, sessionKey, derived, 'auto')?.title ?? derived;
    return sessionTitles.resolve(gatewayId, sessionKey);
  };

  app.get('/api/gateways/:id/sessions/:sessionKey', async (c) => {
    try {
      const gatewayId = c.req.param('id');
      const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
      const limit = Number(c.req.query('limit') ?? '80');
      // Served from the hub's cache when warm, so re-opening a conversation
      // renders without a round trip. `fresh=1` forces a re-read for callers
      // that need to see their own write reflected.
      const detail = await sessionHub.getDetail(gatewayId, sessionKey, limit, {
        waitForFresh: c.req.query('fresh') === '1',
      });
      return c.json({ ...detail, title: titleForDetail(gatewayId, sessionKey, detail) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /** Rename a conversation. Control-plane state only — never pushed to the gateway. */
  app.put('/api/gateways/:id/sessions/:sessionKey/title', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'operator')) {
        return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      }
      const gatewayId = c.req.param('id');
      const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
      const body = (await c.req.json().catch(() => ({}))) as { title?: string };
      const title = (body.title ?? '').trim();
      if (title.length > 200) {
        return c.json({ error: 'title too long', code: 'invalid_request' }, 400);
      }
      // An empty title is a reset, not an error: it drops the override and the
      // session falls back to its derived name.
      const record = sessionTitles.set(gatewayId, sessionKey, title, 'manual');
      return c.json({
        ok: true,
        title: record?.title ?? sessionTitles.resolve(gatewayId, sessionKey),
        titleSource: record?.source ?? null,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Live transcript for one session.
   *
   * Replaces the client's 4s poll. The UI previously re-read a whole session
   * detail on a timer whether or not anything had changed; now it holds this
   * open and the server pushes when the gateway reports activity.
   */
  app.get('/api/gateways/:id/sessions/:sessionKey/stream', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const gatewayId = c.req.param('id');
    const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
    const limit = Number(c.req.query('limit') ?? '80');

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ ok: true, gatewayId, sessionKey, mode: 'event-driven' }),
      });

      const queue: Array<{ history?: unknown }> = [];
      let wake: (() => void) | null = null;
      const unsubscribe = sessionHub.subscribe(gatewayId, sessionKey, limit, (detail) => {
        queue.push(detail);
        wake?.();
      });

      // Frames that say nothing new are dropped.
      //
      // The hub re-reads the transcript on every gateway event, and most of
      // those events change nothing about it; forwarding the duplicate would
      // make the client re-render its whole message list — with all its
      // markdown — several times a second while an agent is working, which is
      // what made the transcript feel like it was fighting the scroll wheel.
      // `projectedAt` is excluded because it is a new timestamp every read and
      // would defeat the comparison on its own.
      let lastFingerprint: string | null = null;

      try {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              stream.onAbort(() => resolve());
            });
            wake = null;
            if (closed) break;
          }
          const next = queue.pop();
          queue.length = 0; // only the newest transcript matters
          if (next) {
            const { projectedAt, ...stable } = next as { projectedAt?: string };
            const payload = { ...stable, title: titleForDetail(gatewayId, sessionKey, next) };
            const fingerprint = JSON.stringify(payload);
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              await stream.writeSSE({
                event: 'detail',
                data: JSON.stringify({ ...payload, projectedAt }),
              });
            }
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post('/api/gateways/:id/sessions/:sessionKey/messages', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'operator')) {
        return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      }
      const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
      const body = (await c.req.json().catch(() => ({}))) as {
        message?: string;
        idempotencyKey?: string;
      };
      const message = (body.message ?? '').trim();
      if (!message) {
        return c.json({ error: 'message is required', code: 'invalid_request' }, 400);
      }
      if (message.length > 20_000) {
        return c.json({ error: 'message too long', code: 'invalid_request' }, 400);
      }
      const gatewayId = c.req.param('id');
      // Name the conversation after its opening line, before the send: a new
      // session minted by the sidebar has no transcript to derive from yet, and
      // this is the moment it acquires one.
      sessionTitles.setFromFirstMessage(gatewayId, sessionKey, message);

      const result = await sessions.sendMessage(
        gatewayId,
        sessionKey,
        message,
        user.username,
        body.idempotencyKey
      );

      // Push the updated transcript to anyone watching, but do not make the
      // sender wait for it: the POST returning is what unblocks the composer,
      // and the re-read is only needed so the echo arrives promptly for clients
      // whose gateway event has not landed yet.
      void sessionHub.refreshNow(gatewayId, sessionKey, 80).catch(() => {
        /* the next gateway event or periodic refresh will reconcile */
      });

      return c.json({ result });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ─── Phase 4: approvals + research requests ──────────────────────────────

  app.get('/api/approvals', async (c) => {
    try {
      // Exec approvals ride along with the background sweep. Research requests
      // are a local directory scan, so they stay live on every request.
      const snap = await snapshots.ready();
      const execItems = snap.details.flatMap((d) => d.execApprovals);
      const researchItems = research.listPending();
      const items = [...execItems, ...researchItems];
      return c.json({
        items,
        counts: {
          total: items.length,
          exec: execItems.length,
          research_request: researchItems.length,
        },
        projectedAt: new Date().toISOString(),
        generatedAt: snap.generatedAt,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/approvals/exec/:gatewayId/:approvalId/resolve', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'approver')) {
        return c.json({ error: 'Forbidden — requires approver role', code: 'forbidden' }, 403);
      }
      const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
      const decision = body.decision as ExecApprovalDecision | undefined;
      if (!decision) {
        return c.json(
          { error: 'decision required (allow-once | allow-always | deny)', code: 'invalid_request' },
          400
        );
      }
      const result = await approvals.resolveExec(
        c.req.param('gatewayId'),
        decodeURIComponent(c.req.param('approvalId')),
        decision,
        user.username
      );
      if (!result.ok) {
        return c.json({ error: result.error, code: 'resolve_failed' }, 400);
      }
      // The resolved approval is still in the snapshot; re-sweep so the list
      // and the sidebar badge settle without the client polling for it.
      void snapshots.refresh().catch(() => {});
      return c.json({ ok: true, raw: result.raw });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/approvals/research/:id/resolve', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'approver')) {
        return c.json({ error: 'Forbidden — requires approver role', code: 'forbidden' }, 403);
      }
      const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
      const decision = body.decision === 'reject' ? 'reject' : body.decision === 'approve' ? 'approve' : null;
      if (!decision) {
        return c.json({ error: 'decision required (approve | reject)', code: 'invalid_request' }, 400);
      }
      const id = c.req.param('id');
      // Read the request BEFORE resolving: approve moves the file out of
      // requests/, so this is the last moment its topic_id and query can be
      // recovered without re-reading the copy the enclave now owns.
      const pending = research.listPending().find((item) => item.id === id) ?? null;

      const result = await approvals.resolveResearch(id, decision, user.username);
      if (!result.ok) {
        return c.json({ error: result.error, code: 'resolve_failed' }, 400);
      }

      // Approval is no longer where the control plane's knowledge stops: the
      // tracker carries it through the sealer/curator/sealer chain and reports
      // the answer back. Registering here rather than waiting for the next
      // adoption sweep means the UI shows the request in flight immediately.
      const tracked =
        decision === 'approve'
          ? researchTracker.track({
              topicId: pending?.topicId ?? id,
              requestId: id,
              query: pending?.query ?? null,
              approvedBy: user.username,
            })
          : null;

      return c.json({ ok: true, stdout: result.stdout, tracked });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/research-requests', async (c) => {
    try {
      const items = research.listPending();
      return c.json({
        items,
        // Everything past the gate, with the stage each request has reached.
        tracked: researchTracker.list(),
        projectedAt: new Date().toISOString(),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * The answer, in the control plane.
   *
   * This is the path that does not depend on an agent being awake, on a session
   * still existing, or on a delivery having succeeded — it reads the promoted
   * brief straight off disk. Rendering it is safe in a way that feeding it to an
   * agent is not: a human reading quoted third-party text is the intended
   * audience for it.
   */
  app.get('/api/research-requests/:topicId/result', async (c) => {
    try {
      const topicId = c.req.param('topicId');
      const tracked = researchTracker.get(topicId);
      const brief = research.readBrief(topicId);
      if (!tracked && !brief) {
        return c.json({ error: `unknown research topic: ${topicId}`, code: 'not_found' }, 404);
      }
      return c.json({
        tracked,
        stage: tracked?.stage ?? (brief ? (brief.flagged ? 'brief_flagged' : 'brief_ready') : 'queued'),
        brief,
        projectedAt: new Date().toISOString(),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /** Announce a brief into a session by hand — and the only way to release a held one. */
  app.post('/api/research-requests/:topicId/deliver', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'approver')) {
        return c.json({ error: 'Forbidden — requires approver role', code: 'forbidden' }, 403);
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        gatewayId?: string;
        sessionKey?: string;
      };
      const target =
        body.gatewayId && body.sessionKey
          ? { gatewayId: body.gatewayId, sessionKey: body.sessionKey }
          : null;
      const result = await researchTracker.deliverNow(c.req.param('topicId'), user.username, target);
      if (!result.ok) {
        return c.json({ error: result.error, code: 'deliver_failed' }, 400);
      }
      return c.json({ ok: true, target: result.target });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ─── Phase 5: Audit search / retention / integrity ────────────────────────

  app.get('/api/audit', async (c) => {
    const result = audit.list({
      limit: Number(c.req.query('limit') ?? '100'),
      type: c.req.query('type') || undefined,
      gatewayId: c.req.query('gatewayId') || undefined,
      actorId: c.req.query('actorId') || undefined,
      outcome: c.req.query('outcome') || undefined,
      q: c.req.query('q') || undefined,
      since: c.req.query('since') || undefined,
      until: c.req.query('until') || undefined,
    });
    return c.json(result);
  });

  app.post('/api/audit/retain', async (c) => {
    const user = c.get('user');
    if (!hasRole(user, 'admin')) {
      return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { keep?: number };
    const keep = body.keep ?? config.auditRetention;
    const result = audit.retain(keep);
    audit.append({
      type: 'audit.retain',
      actorType: 'user',
      actorId: user.username,
      gatewayId: null,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `Audit retention keep=${keep} archived=${result.archived}`,
      details: result,
    });
    return c.json(result);
  });

  // ─── Phase 6: Cron / automations ────────────────────────────────────────

  app.get('/api/cron/jobs', async (c) => {
    try {
      const gatewayId = c.req.query('gatewayId') || undefined;
      const items = await cron.listAll(gatewayId);
      return c.json({ items, projectedAt: new Date().toISOString() });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/cron/jobs/:gatewayId/:jobId', async (c) => {
    try {
      const job = await cron.get(c.req.param('gatewayId'), c.req.param('jobId'));
      if (!job) return c.json({ error: 'Job not found', code: 'not_found' }, 404);
      return c.json({ job });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/cron/jobs/:gatewayId/:jobId/runs', async (c) => {
    try {
      const limit = Number(c.req.query('limit') ?? '20');
      const runs = await cron.runs(c.req.param('gatewayId'), c.req.param('jobId'), limit);
      return c.json({ runs });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/cron/jobs/:gatewayId/:jobId/enable', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const job = await cron.setEnabled(c.req.param('gatewayId'), c.req.param('jobId'), true, user.username);
      return c.json({ job });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/cron/jobs/:gatewayId/:jobId/disable', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const job = await cron.setEnabled(c.req.param('gatewayId'), c.req.param('jobId'), false, user.username);
      return c.json({ job });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/cron/jobs/:gatewayId/:jobId/run', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const result = await cron.runNow(c.req.param('gatewayId'), c.req.param('jobId'), user.username);
      return c.json({ result });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/cron/status/:gatewayId', async (c) => {
    try {
      const status = await cron.status(c.req.param('gatewayId'));
      return c.json({ status });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ─── Phase 7: Configuration ─────────────────────────────────────────────

  app.get('/api/config/:gatewayId', async (c) => {
    try {
      const live = await configs.getLive(c.req.param('gatewayId'));
      const versions = configs.listVersions(c.req.param('gatewayId'));
      return c.json({ live, versions });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/config/:gatewayId/schema', async (c) => {
    try {
      const path = c.req.query('path') || 'gateway';
      const schema = await configs.schemaLookup(c.req.param('gatewayId'), path);
      return c.json({ schema });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/config/:gatewayId/snapshot', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { note?: string };
      const meta = configs.snapshot(c.req.param('gatewayId'), user.username, body.note);
      audit.append({
        type: 'config.snapshot',
        actorType: 'user',
        actorId: user.username,
        gatewayId: c.req.param('gatewayId'),
        approvalId: null,
        sessionKey: null,
        outcome: 'ok',
        summary: `Snapshot config for ${c.req.param('gatewayId')}`,
        details: { versionId: meta.id, hash: meta.hash },
      });
      return c.json({ version: meta });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/config/:gatewayId/propose', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { document?: unknown; note?: string };
      if (!body.document) return c.json({ error: 'document required', code: 'invalid_request' }, 400);
      const meta = configs.propose(c.req.param('gatewayId'), body.document, user.username, body.note);
      audit.append({
        type: 'config.propose',
        actorType: 'user',
        actorId: user.username,
        gatewayId: c.req.param('gatewayId'),
        approvalId: null,
        sessionKey: null,
        outcome: 'ok',
        summary: `Proposed config version for ${c.req.param('gatewayId')}`,
        details: { versionId: meta.id, hash: meta.hash },
      });
      return c.json({ version: meta });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/config/:gatewayId/apply', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as {
        versionId?: string;
        expectedHostHash?: string;
      };
      if (!body.versionId) return c.json({ error: 'versionId required', code: 'invalid_request' }, 400);
      const result = configs.applyVersion(
        c.req.param('gatewayId'),
        body.versionId,
        user.username,
        body.expectedHostHash
      );
      return c.json({
        ok: true,
        ...result,
        warning:
          'Host openclaw.json updated. Restart the gateway container to ensure the RO mount is re-read if hot reload does not pick it up.',
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/config/:gatewayId/rollback', async (c) => {
    try {
      const user = c.get('user');
      if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
      const meta = configs.rollback(c.req.param('gatewayId'), user.username);
      return c.json({
        ok: true,
        version: meta,
        warning: 'Rolled back host config. Restart gateway if needed.',
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ─── Phase 8: Security ──────────────────────────────────────────────────

  app.get('/api/security/posture', (c) => c.json({ posture: security.posture() }));

  app.post('/api/security/enclave-check', async (c) => {
    const user = c.get('user');
    if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    const result = await security.runEnclaveCheck();
    audit.append({
      type: 'security.enclave_check',
      actorType: 'user',
      actorId: user.username,
      gatewayId: null,
      approvalId: null,
      sessionKey: null,
      outcome: result.ok ? 'ok' : 'error',
      summary: `enclave-check ${result.summary}`,
    });
    return c.json({ result });
  });

  app.post('/api/security/approvals-drift', async (c) => {
    const user = c.get('user');
    if (!hasRole(user, 'admin')) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    const result = await security.runApprovalsDrift();
    audit.append({
      type: 'security.approvals_drift',
      actorType: 'user',
      actorId: user.username,
      gatewayId: 'main',
      approvalId: null,
      sessionKey: null,
      outcome: result.ok ? 'ok' : 'error',
      summary: `check-approvals ${result.summary}`,
    });
    return c.json({ result });
  });

  // ─── Phase 9: Exchange visibility ───────────────────────────────────────

  app.get('/api/exchange', (c) => c.json(exchange.snapshot()));

  // ─── Realtime: SSE poll (Phase 3 interim without device-paired WS) ───────


  app.get('/api/events/stream', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({
          ok: true,
          mode: 'snapshot-push',
          refreshIntervalMs: config.snapshotRefreshMs,
          note: 'Clients receive the shared fleet snapshot as it refreshes; they do not drive sweeps.',
        }),
      });

      const render = (snap: FleetSnapshot) => {
        const execItems = snap.details.flatMap((d) => d.execApprovals);
        const researchItems = research.listPending();
        const items = [...execItems, ...researchItems];
        return JSON.stringify({
          ts: snap.generatedAt,
          sweepDurationMs: snap.durationMs,
          error: snap.error,
          approvals: {
            items,
            counts: {
              total: items.length,
              exec: execItems.length,
              research_request: researchItems.length,
            },
          },
          gateways: snap.details.map((d) => ({
            gatewayId: d.status.gatewayId,
            status: d.status.status,
            pendingApprovals: d.status.pendingApprovals,
            sessionCount: d.status.sessionCount,
          })),
        });
      };

      // Send whatever is already in memory, then only on change. A connected
      // client no longer causes any Gateway traffic of its own — this loop used
      // to run a full statusAll() every 4s per client, a ~30s operation.
      const existing = snapshots.current();
      if (existing) {
        await stream.writeSSE({ event: 'snapshot', data: render(existing) });
      }

      const queue: FleetSnapshot[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = snapshots.subscribe((snap) => {
        queue.push(snap);
        wake?.();
      });

      try {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              stream.onAbort(() => resolve());
            });
            wake = null;
            if (closed) break;
          }
          const next = queue.pop();
          queue.length = 0; // only the newest snapshot matters
          if (next) {
            await stream.writeSSE({ event: 'snapshot', data: render(next) });
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get('/api/dashboard', async (c) => {
    try {
      // Served from the shared snapshot. This previously ran three sequential
      // stages where stages 2 and 3 re-issued the agents.list /
      // exec.approval.list RPCs the status sweep had already made — 24 Gateway
      // calls to answer 18 calls' worth of questions, in three round trips, on
      // every single page load.
      const snap = await snapshots.ready();
      const details = snap.details;
      const researchItems = research.listPending();

      const agents = details.flatMap((d) => d.agents);
      const execApprovals = details.flatMap((d) => d.execApprovals);

      return c.json({
        gateways: details.map((d) => d.status),
        agentCount: agents.length,
        agentsByGateway: agents.reduce<Record<string, number>>((acc, a) => {
          acc[a.gatewayId] = (acc[a.gatewayId] ?? 0) + 1;
          return acc;
        }, {}),
        pendingApprovals: execApprovals.length + researchItems.length,
        pendingExecApprovals: execApprovals.length,
        pendingResearchRequests: researchItems.length,
        generatedAt: snap.generatedAt,
        sweepDurationMs: snap.durationMs,
        sweepError: snap.error,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Open every gateway link at boot so the first user request never pays for a
  // handshake, and so events start flowing before anyone is watching. Failures
  // are logged and retried with backoff, never thrown: one unpaired gateway
  // must not stop the control plane from serving the other two.
  void persistent?.start();

  // Warm the fleet snapshot from boot so the first page load does not pay for
  // a cold sweep. Failures are recorded on the snapshot, not thrown.
  snapshots.start();

  // Adopts anything still sitting in exchange/inbox, so a restart mid-pipeline
  // resumes rather than abandoning the request.
  researchTracker.start();

  return Object.assign(app, {
    /** Release links and timers; used by tests and graceful shutdown. */
    stop(): void {
      snapshots.stop();
      sessionHub.stop();
      researchTracker.stop();
      persistent?.close();
    },
  });
}

function handleError(c: { json: (body: unknown, status?: number) => Response }, err: unknown) {
  if (err instanceof GatewayNotFoundError) {
    return c.json({ error: err.message, code: err.code }, 404);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, code: 'internal_error' }, 500);
}

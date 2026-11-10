// The disposable PostgreSQL container a real-broker deploy test starts (`postgres:16-alpine`, nothing mounted at its data directory)
// gets an ANONYMOUS volume from the image's `VOLUME /var/lib/postgresql/data`. `docker rm -f` alone leaves that volume behind, nameless
// and unattributable. These helpers identify it exactly when the container is created, and remove it only together with its own container
// (`docker rm -f -v <id>`), then prove it is gone. Never a guessed name, a prefix, a filter or a prune; named volumes are never touched
// (`docker rm -v` removes only the container's anonymous volumes).
import { spawnSync } from 'node:child_process';

export const PG_DATA = '/var/lib/postgresql/data';
const ANONYMOUS = 'com.docker.volume.anonymous';

const docker = (args, env) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', ...(env ? { env } : {}) });
const why = (r) => r.error?.message ?? String(r.stderr ?? '').trim().slice(0, 200);

/**
 * The name of the ONE anonymous volume mounted at PG_DATA in this container. Throws (fail closed) when it cannot be established: the
 * container cannot be inspected, there is not exactly one mount there, it is not a volume with a 64-hex name, or Docker does not label it
 * anonymous. A harness that cannot name the volume must not run, because it could not prove its own cleanup.
 */
export function anonymousDataVolume(container, { env } = {}) {
  const ref = String(container).slice(0, 12);
  const r = docker(['inspect', '-f', '{{json .Mounts}}', container], env);
  if (r.status !== 0) throw new Error(`cannot inspect the PostgreSQL container ${ref}: ${why(r)}`);
  let mounts;
  try { mounts = JSON.parse(r.stdout); } catch { throw new Error(`the mounts of the PostgreSQL container ${ref} are unreadable`); }
  const data = (Array.isArray(mounts) ? mounts : []).filter((m) => m?.Destination === PG_DATA);
  if (data.length !== 1) throw new Error(`expected exactly one mount at ${PG_DATA} in the PostgreSQL container ${ref}, found ${data.length}`);
  const [m] = data;
  if (m.Type !== 'volume' || !/^[0-9a-f]{64}$/.test(String(m.Name))) {
    throw new Error(`the ${PG_DATA} mount of ${ref} is not an anonymous volume (type ${m.Type}, name ${m.Name}): refusing to own it`);
  }
  const l = docker(['volume', 'inspect', '-f', '{{json .Labels}}', m.Name], env);
  if (l.status !== 0) throw new Error(`cannot inspect volume ${m.Name}: ${why(l)}`);
  let labels;
  try { labels = JSON.parse(l.stdout); } catch { labels = undefined; }
  if (!labels || typeof labels !== 'object' || !Object.hasOwn(labels, ANONYMOUS)) {
    throw new Error(`volume ${m.Name} is not labelled ${ANONYMOUS}: refusing to own it`);
  }
  return m.Name;
}

/**
 * Removes this container with its anonymous volumes (`docker rm -f -v`), then proves the recorded volume no longer exists. Throws when
 * the removal fails, when the volume is still there, when its absence cannot be confirmed, or when no identity was recorded (removal was
 * still attempted, but its result cannot be proven). Callers keep cleaning up after a throw and report it.
 */
export function removeWithAnonymousVolume(container, volume, { env } = {}) {
  const ref = String(container).slice(0, 12);
  const r = docker(['rm', '-f', '-v', container], env);
  if (r.status !== 0) throw new Error(`docker rm -f -v ${ref} failed: ${why(r)}`);
  if (volume === undefined) throw new Error(`removed ${ref} with -v, but its anonymous data volume was never identified: cannot prove it is gone`);
  const v = docker(['volume', 'inspect', volume], env);
  if (v.status === 0) throw new Error(`anonymous volume ${volume} still exists after removing ${ref}`);
  if (!/no such volume/i.test(String(v.stderr ?? ''))) throw new Error(`cannot confirm that volume ${volume} is gone: ${why(v)}`);
}

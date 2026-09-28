# Upgrade request for git.buildinelsalvador.com: ngit-grasp 1.2.0 to 3.0.5, then BIES Code to `061cbe31d05825527327a65134e1820f5656dea6`

**From:** SovTech, the maintainers of BIES Code, the web app at https://git.buildinelsalvador.com/
**To:** the administrator of the host that serves git.buildinelsalvador.com (140.99.223.111)

You can follow this by hand, or paste the whole thing into your own AI coding agent. The facts here come from the ngit-grasp v3.0.5 source, changelog and upgrade guide, and from running the same software on our own servers. We cannot see your host, so wherever something depends on your setup, this document tells you how to check it.

---

## Ground rules (read these first)

- **Never print, paste or send anyone the relay owner key.** It can live in the file `.relay-owner.nsec`, in the env var `NGIT_RELAY_OWNER_NSEC`, in a systemd credential called `relay_owner_nsec`, or (under 1.2.0 only) on the command line as `--relay-owner-nsec`. The same goes for every value in the service's env files: report env settings by **key name only**. The commands below print only names, paths, counts and values that are not secret.
- **Don't run these at all**, because each can print the key: `ps aux` / `ps -ef` / `pgrep -a` / `top -c` (they show program arguments), `systemctl status <unit>` (its process tree shows full command lines), `cat /proc/*/cmdline`, `cat /proc/*/environ`, `systemctl show -p Environment`, an unfiltered `systemctl cat` or `systemctl show -p ExecStart`, `docker inspect <container>` without `--format`, `docker compose config`, and `env` or `printenv` in the service's context.
- **Work as root** (`sudo -i`). Git commands against the repositories run as the service user (`sudo -u "$S" …`), so git's ownership check does not refuse them and nothing ends up owned by root.
- **Shell variables are kept in a file**, because an agent's shell (and a human's, after a disconnect) does not survive between steps. Every block after §1.0 starts with `. /root/ngit-upgrade/vars.sh`; whenever a step finds a value, it appends it there. That file holds only paths and names, never a secret.
- Where a block prints `SOMETHING-OK`, a missing `SOMETHING-OK` means **stop**. Where a comment says "must print nothing", any output means stop. In either case, tell us.
- **Sections 1.0–1.7 only read.** Apart from files in `/root/ngit-upgrade`, nothing on the host changes before §1.8.
- **If you are an AI agent:** run §1.0–1.7 and report the results to the operator. Get an explicit go-ahead from the operator before each of these: the nginx reload in §1.8, the stop in §2.2, the first 3.0.5 start in §3.4, the BIES Code switch in §5.4, and any rollback in §7.

### Placeholders

Replace every `<PLACEHOLDER>` with the value below. `BIN`, `W`, `S`, `FP`, `G` and `R` are worked out by the commands themselves.

| Placeholder                                                          | What it is                                                                                                                                          | Where it comes from |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `<UNIT>`                                                             | The full systemd unit name, such as `ngit-grasp.service`                                                                                            | §1.2                |
| `<ENVFILE>`                                                          | The unit's `EnvironmentFile=` path, without a leading `-`. If there are several, handle each one the same way.                                      | §1.2                |
| `<GIT_DATA_PATH>`, `<RELAY_DATA_PATH>`                               | The configured data paths, or `./data/git` and `./data/relay` if nothing sets them                                                                  | §1.4                |
| `<VHOST_FILE>`, `<WEBROOT>`, `<GRASP_UPSTREAM>`, `<CERTBOT_WEBROOT>` | The nginx vhost file, its current `root`, its `proxy_pass` target (for example `127.0.0.1:7334`), and certbot's `webroot_path`, if certbot uses one | §1.6                |
| `<RELEASES>`                                                         | A new directory you choose for web releases, such as `/var/www/bies-code-releases`. It must not be inside `<WEBROOT>`.                              | §1.8                |
| `<NEW_BINARY>`                                                       | The path on this host of the verified 3.0.5 binary                                                                                                  | §3.1                |
| `<DIST_DIR>`                                                         | The path on this host of the BIES Code `dist` directory                                                                                             | §5                  |
| BIES Code commit                                                     | `061cbe31d05825527327a65134e1820f5656dea6` (main on GitHub and ngit)                                                                                | Fixed, from us      |
| Expected bundle                                                      | `index-Di6sUX0Q.js`, dist digest `44910af6c41aa2f8214b5f2348d48de75c2da2c4341c653befd74054b4afb708`                                                 | Fixed, from us      |

Tools you need on the host: `jq`, `curl`, `git`, `ss`. `nak` or `websocat` are optional, for the Nostr checks.

---

## 0. Summary

| Component                                                            | Now                                                                | Target                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ngit-grasp**: Nostr relay plus git smart-HTTP server, behind nginx | 1.2.0                                                              | **3.0.5**: tag `v3.0.5`, commit `66611985d72cdd1f7e6b67f173b02f8c9a4d7af6`, released 2026-09-25. This is the latest release, and relay.ngit.dev runs it. |
| **BIES Code**: a static single-page app that nginx serves at `/`     | July build (`/assets/index-CTKe40JK.js`, gitworkshop base dc36db6) | **`061cbe31d05825527327a65134e1820f5656dea6`** (gitworkshop v4.1+ base 24b7878), main bundle `index-Di6sUX0Q.js`                                         |

**Why upgrade**

- **Security, urgent.** Every ngit-grasp release up to and including 2.1.2 is affected, and that includes 1.2.0:
  - A request with crafted percent-encoded or `../`-style repository coordinates is resolved outside the namespace it asked for. **Anyone, without logging in, can read any git repository the service has access to.**
  - With GRASP-06 enabled, a crafted PR submission can also _write_ git objects and refs into another hosted repository.
  - Only 3.0.0 and later fix this. Upstream's wording is: "Operators must upgrade to v3.0.0."
- **Other security fixes since 1.2.0:**
  - 2.1.0 fixes server-side request forgery (SSRF) through relay or clone URLs supplied inside events.
  - 2.0.0 keeps the owner key out of the process arguments. An empty or invalid configured key now stops startup instead of rotating the relay identity.
  - 3.0.x rejects reposted protected (NIP-70) events, verifies proof-of-work targets, and bounds peer-advertised relay data. A malformed client message no longer drops the whole WebSocket connection.
- The new BIES Code is built for ngit-grasp v3. It relies on v3's reciprocal maintainer-invitation model, and it checks the relay's NIP-05 identity at `/.well-known/nostr.json`.

**Order, and why**

1. **Preparation, with no downtime.** Do these in any order while 1.2.0 keeps running:
   - Discovery: §1.0–1.7.
   - The nginx change: §1.8. Do it **at least a week before §5.4** if you can. Today's `index.html` is served without a cache header, so browsers may keep a stale copy for days. The change also lets you test nginx on its own, before the relay goes down.
   - Getting the 3.0.5 binary: §3.1.
   - Building BIES Code: §5.1–5.3. Build it **before** you stop ngit-grasp, because one of its sources is served by this same relay.
2. **Maintenance window:** stop the service, snapshot its data, install 3.0.5 and start it (§2–§3).
   - The first start of 3.0.5 runs a **one-way storage migration** before it serves anything. For reference, relay.ngit.dev took 51 minutes for 2,294 repositories; §1.4 shows your repository count.
   - During the migration the backend port is already open but nothing answers. Relay, NIP-11 and git requests through nginx **hang** until nginx's timeouts instead of failing fast, and a plain TCP health check reads healthy.
   - The BIES Code page still loads, because it is static files, but it shows no data.
3. **Verify ngit-grasp** (§4). Then tell us, and we will make a test push.
4. **Only after that, switch BIES Code** to the new build (§5.4).
   - The July build keeps working against 3.0.5, so the switch can be in the same window or later.
   - **Never run the new BIES Code against 1.2.0.** The new app writes a `maintainers` compatibility tag that also lists invitees who have not accepted yet. 1.2.0 gives everyone in that tag push and state authority straight away, while the app tells the repository owner that those invitees have none.

---

## 1. Preparation

### 1.0 Set up the working directory

```bash
install -d -m 0700 /root/ngit-upgrade
V=/root/ngit-upgrade/vars.sh; [ -e "$V" ] || install -m 0600 /dev/null "$V"
B=/root/ngit-upgrade      # the snapshot goes here later. If /root lacks the space (§1.4), use another root-only directory outside the ngit data.
install -d -m 0700 "$B"
printf '%s=%q\n' V "$V" B "$B" H https://git.buildinelsalvador.com NPUB npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx >> "$V"
```

### 1.1 Host

```bash
. /root/ngit-upgrade/vars.sh
uname -m                                  # x86_64: the static and prebuilt binaries apply; anything else: build from source
grep '^PRETTY_NAME=' /etc/os-release
test -e /etc/NIXOS && echo "NIXOS: follow §3.9 as well"
git --version; nginx -v
command -v jq curl ss docker podman
```

v3 runs the `git` binary **at startup**, not only for git smart-HTTP, because the migration needs it.

- **The minimum is git 2.29.** We worked that out from the flags v3 uses; upstream documents no minimum.
- **2.37 or later is recommended.** Older git silently ignores `-c http.curloptResolve`, which v3 uses to pin DNS as part of its SSRF protection. On older git that protection is lost without any error.
- Distro versions: Debian 12 ships 2.39, Ubuntu 24.04 ships 2.43, and Ubuntu 22.04 ships 2.34. 2.34 runs v3 but without the DNS pin, so consider a newer git, for example from the git-core PPA.

### 1.2 Find the service, binary, user and working directory

```bash
. /root/ngit-upgrade/vars.sh
systemctl list-units --all --type=service --no-pager | grep -iE 'ngit|grasp'
pgrep -x ngit-grasp                       # PIDs only
command -v docker >/dev/null && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'ngit|grasp'
```

If it runs in a container, read §3.7 as well; if the host is NixOS, read §3.9. Everything else assumes a systemd-managed binary.

```bash
. /root/ngit-upgrade/vars.sh
U=<UNIT>
systemctl show -p FragmentPath,DropInPaths,MainPID,ActiveState,UpheldBy,TriggeredBy,WorkingDirectory "$U"
PID=$(systemctl show -p MainPID --value "$U")
BIN=$(readlink -f /proc/$PID/exe)
case "${BIN##*/}" in bash|sh|dash) echo "SHELL WRAPPER: using its child"; PID=$(pgrep -P "$PID" | head -1); BIN=$(readlink -f /proc/$PID/exe);; esac
W=$(readlink -f /proc/$PID/cwd)           # the key file and relative data paths resolve here
S=$(stat -c %U /proc/$PID)                # the service user
FP=$(systemctl show -p FragmentPath --value "$U")
echo "BIN=$BIN W=$W S=$S FP=$FP"
cat /proc/$PID/cgroup                     # must name the unit; if it names a user session, screen or tmux, stop and tell us
ss -ltnpH | grep "pid=$PID," | awk '{print $4}'   # the backend address: expect 127.0.0.1:7334 or [::1]:…
printf '%s=%q\n' U "$U" BIN "$BIN" W "$W" S "$S" FP "$FP" >> "$V"
```

If the backend listens on `0.0.0.0` or `[::]`, tell us. In that case do **not** set `NGIT_TRUSTED_PROXY_CIDRS` in §3.2. From another machine, `curl --max-time 5 http://140.99.223.111:<port>/metrics` must fail to connect.

```bash
. /root/ngit-upgrade/vars.sh
# Unit settings, allow-listed fields only (SetCredential= and Environment= values are deliberately not printed)
systemctl cat "$U" | grep -E '^(User|Group|WorkingDirectory|EnvironmentFile|Type|Restart|RestartSec|TimeoutStopSec|ProtectSystem|ProtectHome|ReadWritePaths|LoadCredential[A-Za-z]*)='
systemctl cat "$U" | grep -E '^ExecStart=' | awk '{print $1}'                 # the program only
systemctl cat "$U" | grep -E '^ExecStart=' | grep -oE -- '--[a-z0-9-]+'       # flag NAMES only
systemctl cat "$U" | grep -E '^Environment=' | grep -oE '\bNGIT_[A-Z0-9_]+='  # inline key NAMES only
systemctl cat "$U" | grep -oE 'NGIT_(DOMAIN|BASE_PATH|BIND_ADDRESS|GIT_DATA_PATH|RELAY_DATA_PATH|DATABASE_BACKEND|GRASP06_ENABLE|METRICS_ENABLED)=[^ "]*'
systemctl cat "$U" | grep -oE -- '--(domain|bind-address|git-data-path|relay-data-path|grasp06-enable)[= ][^ "]*'
systemctl cat "$U" | grep -cE '^SetCredential'                                # count only
systemctl cat "$U" | grep -oE '\bPATH=[^ "]*'                                 # the unit's PATH, if it sets one
(cd / && "$BIN" --version)                # expect: ngit-grasp 1.2.0 (it exits before touching any data)
ls -l "$BIN"; dpkg -S "$BIN" 2>/dev/null  # how it was installed (~/.cargo/bin means cargo install, and so on)
sudo -u "$S" env PATH=<the unit PATH, or /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin> git --version
```

Your NIP-11 reports a bare `1.2.0`, which means the binary was built without git metadata, typically through Nix/NixOS or `cargo install` from crates.io. Tell us which it was.

### 1.3 Env settings and the owner key (names and states only)

```bash
. /root/ngit-upgrade/vars.sh
E=<ENVFILE>          # leave empty (E=) if the unit has no EnvironmentFile=
# The binary also loads a .env file: it looks in its working directory, then in each parent directory, and the first one found wins
d="$W"; while :; do [ -f "$d/.env" ] && echo "DOTENV $d/.env"; [ "$d" = / ] && break; d=$(dirname "$d"); done
DOTENV=<the first DOTENV path printed above>     # leave empty if none was printed
printf '%s=%q\n' E "$E" DOTENV "$DOTENV" >> "$V"
for f in "$E" "$DOTENV"; do [ -f "$f" ] && { echo "== $f (key names)"; grep -vE '^[[:space:]]*(#|$)' "$f" | sed -E 's/^[[:space:]]*export[[:space:]]+//' | cut -d= -f1; }; done
# Non-secret settings (these values are fine to share with us)
grep -hE '^[[:space:]]*(export +)?NGIT_(DOMAIN|BASE_PATH|BIND_ADDRESS|GIT_DATA_PATH|RELAY_DATA_PATH|DATABASE_BACKEND|GRASP06_ENABLE|METRICS_ENABLED)=' "$E" "$DOTENV" 2>/dev/null
```

Now find where the owner key comes from, without reading it:

```bash
. /root/ngit-upgrade/vars.sh
stat -c '%U:%G %a %n' "$W/.relay-owner.nsec" 2>/dev/null || echo "no .relay-owner.nsec in the working directory"
awk '{sub(/^[ \t]*export[ \t]+/,"")} /^NGIT_RELAY_OWNER_NSEC=/{v=substr($0,23); gsub(/[^A-Za-z0-9]/,"",v); print FILENAME": NGIT_RELAY_OWNER_NSEC " (v=="" ? "SET BUT EMPTY" : "set, non-empty")}' "$E" "$DOTENV" 2>/dev/null
systemctl cat "$U" | grep -cE '^Environment=.*NGIT_RELAY_OWNER_NSEC='          # inline in the unit: count only
systemctl cat "$U" | grep -cE '^(LoadCredential|SetCredential)[A-Za-z]*=relay_owner_nsec'   # count only
L=$(systemctl cat "$U" | grep -E '^ExecStart=.*--relay-owner-nsec')
case "$L" in
  "") echo "FLAG: none";;
  *'$(cat '*|*'/cat '*) echo "FLAG: reads a file";;
  *'$'*) echo "FLAG: variable";;
  *) echo "FLAG: literal key";;
esac; unset L
# Only if it said "reads a file": which file (a path, not the key)
systemctl cat "$U" | grep -E '^ExecStart=.*--relay-owner-nsec' | grep -oE '\$\([^)]*cat[[:space:]]+[^)[:space:]]+\)' | sed -E 's/.*cat[[:space:]]+//; s/\)$//'
```

Record the source as **one** of these values:

- `file`: only `.relay-owner.nsec` exists.
- `env`: `NGIT_RELAY_OWNER_NSEC` is set, non-empty.
- `flag-literal`, `flag-file` or `flag-variable`: `--relay-owner-nsec` is in `ExecStart`, in the form the `case` printed.

```bash
. /root/ngit-upgrade/vars.sh
KEYSRC=<file|env|flag-literal|flag-file|flag-variable>
KEYFLAGFILE=<only for flag-file: the path printed above; otherwise leave empty>
printf '%s=%q\n' KEYSRC "$KEYSRC" KEYFLAGFILE "$KEYFLAGFILE" >> "$V"
```

- v3 looks for the key in this order: the systemd credential `relay_owner_nsec`, then `NGIT_RELAY_OWNER_NSEC`, then `<WORKDIR>/.relay-owner.nsec`.
- **If none of them exists, v3 silently generates a new relay identity.**
- **Stop and tell us** if you find more than one source, a `relay_owner_nsec` credential line (1.2.0 cannot use one, but v3 would prefer it), `SET BUT EMPTY`, or no source at all.

### 1.4 Data paths, size, and things that would abort the migration

```bash
. /root/ngit-upgrade/vars.sh
journalctl -u "$U" --no-pager -o cat | grep -oE '(Git|Relay) data directory: .*' | tail -2   # what 1.2.0 logged at its last start (relative paths are relative to $W)
for p in $(pgrep -x ngit-grasp); do ls -l /proc/$p/fd 2>/dev/null; done | grep -oE '/[^ ]+/data\.mdb' | sort -u   # the LMDB file 1.2.0 has open
```

The journal lines, the settings from §1.2 and §1.3, and the open `data.mdb` must all agree. If they don't, stop and send us all of them.

```bash
. /root/ngit-upgrade/vars.sh
G=$(cd "$W" && readlink -f <GIT_DATA_PATH>); R=$(cd "$W" && readlink -f <RELAY_DATA_PATH>)
echo "G=$G R=$R"; printf '%s=%q\n' G "$G" R "$R" >> "$V"
```

If a configured path goes through a symlink, so the resolved path differs from what is configured, tell us. After v3 migrates, the **resolved absolute path is written into every repository**. From then on it must never change: a restore must go back to exactly that path, and if the path moves, the next start aborts with `uses an unknown alternate; refusing lossy migration`.

```bash
. /root/ngit-upgrade/vars.sh
ls -A "$W"     # names only: tell us about anything besides the key, .env and the data directories
ls -A "$G"     # expect npub1… directories, prs/, purgatory-state.json and rejected-events-cache.json. v3 silently skips anything else: it is neither migrated nor served.
test -e "$G/.grasp" && echo "STOP: $G/.grasp exists, so v3 has already run on this data. Tell us."
find "$G" -mindepth 2 -maxdepth 3 -type d -name '*.git' ! -path "$G/.*" | wc -l | tee "$B/repo-count-before.txt"
EXPECTED=$(cd "$G" && ls -d npub1*/*.git prs/*/*.git 2>/dev/null | sed 's#.*/##' | sort -u | wc -l); echo "identifiers: $EXPECTED"; printf 'EXPECTED=%q\n' "$EXPECTED" >> "$V"
# Each of the next four must print nothing. Any output either aborts the v3 migration or makes it skip repositories silently.
find "$G" -path '*/objects/info/alternates' ! -path "$G/.*"
find "$G" -mindepth 1 -maxdepth 3 -type l ! -path "$G/.*" ! -path "$G/npub1*/*.git/*"
find "$G" -mindepth 2 -maxdepth 3 -type d \( -name '.git' -o -name '..git' -o -name '...git' \)
(cd "$G" && for r in npub1*/*.git prs/*/*.git; do [ -d "$r" ] || continue; f=$(cd "$r" && sudo -u "$S" git rev-parse --show-object-format 2>&1); case "$f" in sha1|sha256) ;; *) echo "WOULD-ABORT $r: $f";; esac; done)
du -sh "$G" "$R"; df -h "$G" "$B"
# Largest "identifier family" (every owner and prs/ repository sharing one name): the migration needs about one extra copy of it
(cd "$G" && du -sk npub1*/*.git prs/*/*.git 2>/dev/null) | awk '{n=$2; sub(/.*\//,"",n); s[n]+=$1} END{for(k in s) print s[k]" KiB", k}' | sort -n | tail -3
```

- The `WOULD-ABORT` loop runs git in each repository as the service user, exactly as v3's migration does. An empty or half-created repository directory, or a "dubious ownership" error, aborts the whole start.
- **Free space** on the git-data filesystem: the current size **plus** the largest family. On `$B`'s filesystem you need room for the snapshot, and room for one more full copy if you ever roll back.
- **Optional:** fsck every repository. This can be slow on a large host. A failure here can be a push that was in flight; re-run that one repository after the stop in §2.2.

```bash
. /root/ngit-upgrade/vars.sh
(cd "$G" && for r in npub1*/*.git prs/*/*.git; do [ -d "$r" ] || continue; sudo -u "$S" git --git-dir="$r" fsck --no-dangling --no-progress >/dev/null 2>&1 || echo "FSCK-FAIL $r"; done)
```

### 1.5 Jobs, monitors and backups that would interfere

```bash
grep -rlE 'repair-deletion-requests|git (gc|repack|prune)|mdb_copy|ngit' /etc/cron* /var/spool/cron /etc/systemd/system /usr/local/bin /usr/local/sbin 2>/dev/null
systemctl list-timers --all --no-pager
```

- **Removed command:** the `repair-deletion-requests` subcommand no longer exists, so anything that calls it will fail.
- **Garbage collection:** after v3, **never run git gc, repack or prune against the git data.** v3 deliberately never deletes objects.
- **Backups break in two common patterns.** After v3, every git object lives under the dot-directory `<G>/.grasp/families/`, and the relay store uses the LMDB 1.0 format.
  - A backup that skips dotfiles, or copies only `*/*.git`, keeps the refs and **silently loses every object**.
  - Debian's and Ubuntu's `mdb_copy` (LMDB 0.9) refuses the store with `MDB_VERSION_MISMATCH`. A copy of `data.mdb` taken while the service runs can be torn.

  Note any backup job that does either; §3.8 has the fix.

- **Restarters:** any health check, watchdog or container auto-healer that restarts the service when it stops answering must be **paused during the first 3.0.5 start**.

### 1.6 nginx, certificates and what sits in front

```bash
. /root/ngit-upgrade/vars.sh
grep -rl 'git.buildinelsalvador.com' /etc/nginx/                           # → <VHOST_FILE>
nginx -T 2>/dev/null | grep -nE 'open_file_cache|map \$http_upgrade'
grep -hE '^(authenticator|installer|webroot_path)|^[[:space:]]*git\.buildinelsalvador\.com[[:space:]]*=' /etc/letsencrypt/renewal/*.conf 2>/dev/null
getent ahosts git.buildinelsalvador.com | awk '{print $1}' | sort -u     # anything but this host's own addresses means something sits in front
curl -sI "$H/" | grep -iE '^(server|via|age|x-cache|cf-ray|cache-control):'
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$H/.well-known/nostr.json"
ls -la <WEBROOT>/.well-known/ 2>/dev/null
```

In `<VHOST_FILE>`, note the following:

- The `root` directive. That is `<WEBROOT>`.
- Every `proxy_pass` target. That is `<GRASP_UPSTREAM>`, and it must match the backend address from §1.2.
- Whether any `proxy_pass` has a URI part, such as `…:7334/`.
- Any `add_header` lines, especially `Access-Control-*` or `Content-Security-Policy`.
- Whether any location **other than `/`** carries relay WebSocket traffic. v3 accepts WebSocket upgrades only at `/`.
- Whether `/.well-known/`, `/metrics` or `/prs/` have their own routes today.

Two findings need action before you continue:

- If `/.well-known/nostr.json` returns `200 application/json` today, stop and tell us which names it lists (`curl -s "$H/.well-known/nostr.json" | jq -r '.names|keys[]'`). §1.8 hands that path to the relay.
- If certbot uses `authenticator = webroot`, note its `webroot_path` as `<CERTBOT_WEBROOT>`. §1.8 changes `root`, and without the extra location shown there, renewals would fail silently until the certificate expires.

### 1.7 Public baselines

```bash
. /root/ngit-upgrade/vars.sh
curl -s -H 'Accept: application/nostr+json' "$H/" > "$B/nip11-before.json"; jq '{version,pubkey,supported_nips,supported_grasps}' "$B/nip11-before.json"
jq -e '.pubkey|test("^[0-9a-f]{64}$")' "$B/nip11-before.json" >/dev/null && echo BASELINE-OK
git ls-remote "$H/$NPUB/bies-code.git" > "$B/bies-code-refs-before.txt"; [ -s "$B/bies-code-refs-before.txt" ] && echo REFS-BASELINE-OK
curl -s "$H/" | grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"'          # expect src="/assets/index-CTKe40JK.js"
curl -s --http1.1 --max-time 5 -o /dev/null -D - -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$H/" | head -1   # HTTP/1.1 101
nak req -k 30617 -l 500 wss://git.buildinelsalvador.com 2>/dev/null | wc -l > "$B/ann-count-before.txt"   # optional; needs nak
```

- The NIP-11 `pubkey` is the relay's public identity. **After the upgrade it must be exactly the same.**
- If `supported_grasps` lists `GRASP-06`, or `NGIT_GRASP06_ENABLE` is (or ever was) true, §4.4 is mandatory.
- **Run this block again in §2.1**, right before the stop, so the baseline is as fresh as possible.

### 1.8 Change nginx while 1.2.0 is still running

This step changes the host, so get the go-ahead first if you are an agent. It moves the July build into a release directory and switches nginx to the routing that v3 and the new app need. Everything in it also works with 1.2.0. Doing it now means an nginx mistake cannot be confused with a v3 problem later.

```bash
. /root/ngit-upgrade/vars.sh
RELS=<RELEASES>
install -d -m 0755 "$RELS/july-CTKe40JK"
cp -a <WEBROOT>/. "$RELS/july-CTKe40JK/"
ln -sfn july-CTKe40JK "$RELS/current"
printf 'RELS=%q\n' "$RELS" >> "$V"
tar -C / -czf "$B/etc-nginx-before.tar.gz" etc/nginx
cp -a <VHOST_FILE> "$B/vhost-before.conf"
```

Merge the following into the existing `git.buildinelsalvador.com` server block, replacing `<GRASP_UPSTREAM>` everywhere:

- **Keep** your `listen`, TLS and certbot lines, and any existing `/.well-known/acme-challenge/` location.
- Keep `<WEBROOT>` itself untouched. The certbot location below and the §7.2 rollback both use it.
- This is the routing we run and have tested on our own server. Lines marked `NEW` are additions we have not yet tested there.

```nginx
# http {} context, once. If you already have an equivalent map, reuse it instead.
map $http_upgrade $ngit_connection_upgrade { default upgrade; '' close; }

# inside server { server_name git.buildinelsalvador.com; ... }
root <RELEASES>/current;           # points at the July build until §5.4
index index.html;

# ONLY if §1.6 showed authenticator = webroot and no such location exists yet:
# location ^~ /.well-known/acme-challenge/ { root <CERTBOT_WEBROOT>; try_files $uri =404; }

location = / {                     # WebSocket and NIP-11 go to the relay; normal browsers get the app
    if ($http_upgrade) { proxy_pass http://<GRASP_UPSTREAM>; }
    if ($http_accept ~* "application/nostr\+json") { proxy_pass http://<GRASP_UPSTREAM>; }
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $ngit_connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 7d;         # the 60 s default drops idle relay WebSockets
    proxy_send_timeout 7d;
    expires epoch;                 # NEW: index.html must revalidate
    try_files /index.html =404;
}
location ~ "^/[^/]+/[^/]+\.git(/|$)" {      # git smart-HTTP and repository landing pages
    proxy_pass http://<GRASP_UPSTREAM>;      # NO trailing slash or path
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 0;        # the 1 MB default makes git push fail with 413
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;         # since 2.0 a push's final flush waits until its events are promoted
    proxy_send_timeout 1h;
}
location ^~ /prs/ {                # GRASP-06 (the relay answers 404 if it is disabled)
    proxy_pass http://<GRASP_UPSTREAM>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
location = /.well-known/nostr.json {        # NEW: NIP-05 _@domain, served by v3 (the new BIES Code checks it)
    proxy_pass http://<GRASP_UPSTREAM>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
location = /icon.png {                      # NEW: the relay icon that NIP-11 advertises
    proxy_pass http://<GRASP_UPSTREAM>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
location = /metrics { return 404; }         # keep Prometheus metrics private
location ^~ /assets/ { try_files $uri =404; expires max; }   # NEW: a missing chunk returns 404, never HTML
location / { try_files $uri /index.html; expires epoch; }     # app deep links; NEW: expires epoch
```

- **Never write `proxy_pass http://…:7334/;`** with a trailing slash or path. nginx then normalises and decodes the URI, and v3 rejects repository coordinates that are not canonical.
- **Do not add `Access-Control-*` headers** on relay or git paths. ngit-grasp sends its own CORS headers, and duplicate headers make browsers reject the response.
- **Don't add a CSP header** stricter than the app's own meta CSP (`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob: https: wss:`). Browsers enforce both.
- **`add_header` inheritance:** `expires` does not affect it. But if you add an `add_header` inside any location, you must repeat your server-level `add_header` lines in that location.
- **If a CDN or caching proxy sits in front:**
  - Bypass its cache for `/`, `/index.html` and `/.well-known/nostr.json`, because `/` returns either HTML or NIP-11 JSON depending on the `Accept` header.
  - Pass WebSockets through.
  - In §3.2, list only proxy hops you control in `NGIT_TRUSTED_PROXY_CIDRS`.

Reload, then check everything against 1.2.0:

```bash
. /root/ngit-upgrade/vars.sh
nginx -t && systemctl reload nginx
curl -s "$H/" | grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"'                  # still src="/assets/index-CTKe40JK.js"
[ "$(curl -s -H 'Accept: application/nostr+json' "$H/" | jq -er .pubkey)" = "$(jq -er .pubkey "$B/nip11-before.json")" ] && echo NIP11-OK
curl -s --http1.1 --max-time 5 -o /dev/null -D - -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$H/" | head -1   # HTTP/1.1 101
git ls-remote "$H/$NPUB/bies-code.git" | cmp -s - "$B/bies-code-refs-before.txt" && echo GIT-OK   # differs only if someone pushed meanwhile
curl -so /dev/null -w '%{http_code}\n' "$H/metrics"                                  # 404
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/assets/does-not-exist.js"   # 404, never "200 text/html"
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/$NPUB/bies-code"           # 200 text/html (app deep link)
curl -sI "$H/" | grep -i '^cache-control'                                           # no-cache
certbot renew --dry-run --cert-name git.buildinelsalvador.com                        # only if certbot uses webroot; must succeed
```

If anything fails, put the old vhost back with `cp -a "$B/vhost-before.conf" <VHOST_FILE>`, then run `nginx -t && systemctl reload nginx`, and tell us.

---

## 2. Maintenance window: stop and snapshot

### 2.1 Before the stop

1. Announce the window. Pause the monitors and restarters you found in §1.5.
2. Run the §1.7 baseline block again. `BASELINE-OK` and `REFS-BASELINE-OK` must both print.
3. Back up the configuration and give the stop a 5-minute grace period:

```bash
. /root/ngit-upgrade/vars.sh
for v in U BIN W S FP G R B; do [ -n "${!v}" ] || echo "MISSING $v - stop"; done
cp -a "$BIN" "$B/ngit-grasp-1.2.0"; sha256sum "$B/ngit-grasp-1.2.0" > "$B/ngit-grasp-1.2.0.sha256"
cp -a "$FP" "$B/"
[ -d "/etc/systemd/system/$U.d" ] && cp -a "/etc/systemd/system/$U.d" "$B/unit-dropins-before"
[ -n "$E" ] && [ -f "$E" ] && cp -a "$E" "$B/"        # contains secrets; $B is root-only
# 1.2.0 writes a checkpoint on SIGTERM; the systemd default of 90 s is followed by SIGKILL
install -d -m 0755 "/etc/systemd/system/$U.d"
printf '[Service]\nTimeoutStopSec=300s\n' > "/etc/systemd/system/$U.d/40-ngit-stop-timeout.conf"
systemctl daemon-reload; systemctl show -p TimeoutStopUSec --value "$U"      # 5min
```

On NixOS, `/etc/systemd/system` is read-only; §3.9 gives the replacement.

### 2.2 Stop the service and prove it has stopped

```bash
. /root/ngit-upgrade/vars.sh
systemctl stop "$U"                   # can take up to 5 minutes
systemctl is-active "$U"              # inactive (or failed)
systemctl show -p Result --value "$U" # success; "timeout" means it was killed, so tell us
pgrep -x ngit-grasp || echo "no ngit-grasp process"
find /proc/[0-9]*/fd -maxdepth 1 \( -lname "$G/*" -o -lname "$R/*" \) 2>/dev/null | wc -l   # 0: nothing holds the data open
```

If the unit shows as active again, something is reviving it; check `UpheldBy` and `TriggeredBy` from §1.2 and stop that as well. **Copy nothing while any ngit-grasp process is running.** The git data, the LMDB store and the key must all come from the same moment.

Now record the on-disk refs of every repository. It is safe to do now, because nothing is writing.

```bash
. /root/ngit-upgrade/vars.sh
(cd "$G" && for r in npub1*/*.git prs/*/*.git; do [ -d "$r" ] || continue; printf '%s %s\n' "$(sudo -u "$S" git --git-dir="$r" for-each-ref --format='%(objectname) %(refname)' | sha256sum | cut -c1-16)" "$r"; done) > "$B/refs-before.txt"; wc -l < "$B/refs-before.txt"
```

### 2.3 Snapshot the state: the key, .env, git data and relay data together

```bash
. /root/ngit-upgrade/vars.sh
P=()
for f in "$W/.relay-owner.nsec" "$DOTENV"; do
  [ -n "$f" ] || continue
  [ -L "$f" ] && echo "SYMLINK $f - stop, tell us"
  [ -f "$f" ] && P+=("${f#/}")
done
case "$R/" in "$G/"*) P+=("${G#/}");; *) case "$G/" in "$R/"*) P+=("${R#/}");; *) P+=("${G#/}" "${R#/}");; esac;; esac
for p in "${P[@]}"; do [ -n "$p" ] || echo "EMPTY PATH - stop"; mountpoint -q "/$p" && echo "MOUNT POINT /$p - tell us before continuing"; done
case "$B/" in "$G/"*|"$R/"*) echo "B is inside the data - stop";; esac
printf '%s\n' "${P[@]}" | tee "$B/archived-paths.txt"
du -sh --apparent-size "$R"; du -sh "$R"      # apparent size much larger than real means a sparse LMDB file; --sparse below handles it
(umask 077; tar --sparse -C / -czf "$B/ngit-state-pre-v3.tar.gz" "${P[@]}") && echo SNAPSHOT-OK
sha256sum "$B/ngit-state-pre-v3.tar.gz" | tee "$B/ngit-state-pre-v3.tar.gz.sha256"
# Verify by listing only; never extract or print the key
tar -tzf "$B/ngit-state-pre-v3.tar.gz" | grep -c 'relay-owner\.nsec$'   # 1 if the key is file-based
tar -tzf "$B/ngit-state-pre-v3.tar.gz" | grep -c '/data\.mdb$'          # 1 or more (LMDB stores)
tar -tzf "$B/ngit-state-pre-v3.tar.gz" | grep -c '\.git/HEAD$'          # about the repo count from §1.4
df -h "$G"                                                               # free space must still cover the largest family
```

- **Stop if `SNAPSHOT-OK` is missing or tar printed any warning.**
- Do not use `mdb_copy`, and never rsync a running instance.
- The snapshot may contain the owner key. Keep it root-only, never copy it off the host unencrypted, and delete it when the rollback period ends.

### 2.4 Optional rehearsal (recommended if §1.4 found more than a few hundred repositories)

Upstream's guide covers v2 to v3. Going straight from 1.2.0 is supported by the code, since the on-disk layout of 1.2.0 is the same as v2's and the v2 migrations run on every v3 start, but it is not explicitly documented. A rehearsal also tells you how long your window must be.

1. Do §2.1–2.3 in a short first window, then run `systemctl start "$U"` to bring 1.2.0 back. The data is untouched, because the migration has not run yet.
2. Run 3.0.5 on a copy, offline, without the key or the `.env`. The throwaway key it generates in the scratch directory is deleted along with the copy. You need space for a full copy plus the largest family.

```bash
. /root/ngit-upgrade/vars.sh
case "$DOTENV" in /.env|/var/.env|/var/tmp/.env) echo "the rehearsal would load $DOTENV - stop, tell us";; esac
SCR=/var/tmp/ngit-rehearsal; install -d -m 0700 -o "$S" "$SCR"
tar --sparse -C "$SCR" --exclude='*/.relay-owner.nsec' --exclude='*/.env' -xzpf "$B/ngit-state-pre-v3.tar.gz"; chown -R "$S": "$SCR"
systemd-run --unit=ngit-rehearsal -p User="$S" -p PrivateNetwork=yes -p PrivateTmp=yes -p WorkingDirectory="$SCR" -p TimeoutStopSec=300 \
  -E NGIT_DOMAIN=git.buildinelsalvador.com -E NGIT_BIND_ADDRESS=127.0.0.1:17334 \
  -E NGIT_GIT_DATA_PATH="$SCR$G" -E NGIT_RELAY_DATA_PATH="$SCR$R" \
  -E NGIT_USER_INDEX_RELAYS= -E NGIT_SYNC_PLUS_ENABLED=false <NEW_BINARY>
journalctl -u ngit-rehearsal --no-pager -o cat | grep -E 'Database backend|storage migration completed|Starting HTTP server|^Error'   # repeat until "Starting HTTP server" or an Error
systemctl stop ngit-rehearsal; rm -rf -- /var/tmp/ngit-rehearsal
```

- `<NEW_BINARY>` must be a path the service user can execute. `/var/tmp` must have the space; any other root-owned directory with room works too.
- Add any other non-secret `NGIT_` settings from §1.3, such as `NGIT_DATABASE_BACKEND` or `NGIT_GRASP06_ENABLE`, as extra `-E` flags. Note how long it took from `Database backend` to `migration completed`, and send us any `Error` line. Then run the real window from §2.1, with a fresh snapshot.

**Never point a rehearsal at the live directories.** One state directory must only ever have one writer.

---

## 3. Upgrade ngit-grasp to 3.0.5

### 3.1 Get the binary (before the window)

Build as an unprivileged account, never as root or as the service user. Preferably build on another machine, then copy only the binary to the host and check its sha256 there. Pick one option and tell us which you used.

**A. Static build with Nix (upstream's documented route for plain Linux servers).** The result is a static musl x86_64 binary, so the host's glibc and OpenSSL don't matter.

```bash
git clone https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit-grasp.git
#   alternatives: https://ngit.dev/ngit-grasp.git, or nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/relay.ngit.dev/ngit-grasp
cd ngit-grasp && git checkout --detach v3.0.5
test "$(git rev-parse HEAD)" = 66611985d72cdd1f7e6b67f173b02f8c9a4d7af6 && echo TAG-OK
nix --extra-experimental-features 'nix-command flakes' build .#static    # → result/bin/ngit-grasp
```

**A2. Cargo, from the same verified checkout (no Nix).**

- It needs a C compiler, `pkg-config`, OpenSSL headers, and a current stable Rust from rustup (1.80 at the very least; upstream builds with 1.96). Distro Rust is too old: Ubuntu 24.04 ships 1.75 and Debian 12 ships 1.63.
- The result links OpenSSL dynamically, so build on the same distro release as the server.

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev    # plus rustup's stable toolchain for your build user
cargo build --release --locked --bin ngit-grasp                   # → target/release/ngit-grasp
```

**B. crates.io:** run `cargo install ngit-grasp --version 3.0.5 --locked --root ~/ngit-grasp-3.0.5`. It has the same prerequisites as A2. Upstream publishes to crates.io from its tag CI, but we have not confirmed that 3.0.5 is there.

**C. The signed prebuilt release** `ngit-grasp-3.0.5-x86_64-unknown-linux-musl.tar.gz` (x86_64 only).

- It is a NIP-82 release: the files are on Blossom servers (blossom.primal.net, blossom.ditto.pub, haven.danconwaydev.com), and the metadata events are on relay.zapstore.dev, relay.ditto.pub, relay.dreamith.to and relay.primal.net.
- **There is no separate checksum file.** The SHA-256 is carried only in the kind-3063 event, which must be signed by `npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr`.
- Use this option only if you can verify that event's author and signature and compare its SHA-256 with the tarball's. We have not verified that publication ourselves.

Whichever you choose, check the result on the host:

```bash
(cd / && <NEW_BINARY> --version)       # ngit-grasp 3.0.5
sha256sum <NEW_BINARY>                  # report this to us
```

If you would rather get a binary and its sha256 from us, ask. For a container, see §3.7. For NixOS, see §3.9.

### 3.2 What changes between 1.2.0 and 3.0.5, and the edits it needs

| In 1.2.0                                                              | In 3.0.5                                                                                                                                                                                              | What you do                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--relay-owner-nsec` command-line flag                                | **Removed** (since 2.0.0). Command-line parsing fails.                                                                                                                                                | Below, by key source                                                      |
| An empty or invalid configured key could silently rotate the identity | **Fatal at startup**                                                                                                                                                                                  | Make sure the source holds the key (§1.3)                                 |
| Key file could have any mode                                          | v3 sets it to 0600 at start, and **startup fails** if the service user cannot                                                                                                                         | The service user owns it, mode 0600                                       |
| No key anywhere: a new one is generated                               | The same, and silently                                                                                                                                                                                | Keep the **same working directory**                                       |
| Hidden `repair-deletion-requests` subcommand                          | Removed                                                                                                                                                                                               | Delete anything that calls it (§1.5)                                      |
| Metric `ngit_sync_naughty_relay_info`                                 | Removed; use `ngit_sync_naughty_relays_total{category}`                                                                                                                                               | Update dashboards                                                         |
| git needed only for smart-HTTP                                        | git needed **to start** (the migration)                                                                                                                                                               | git 2.29 or later (ideally 2.37 or later) on the unit's PATH              |
| Anyone in a `maintainers` tag gets authority, recursively             | Authority must be **reciprocal**: a listed pubkey is only _invited_ until its own kind-30617 lists an existing maintainer back. NIP-34 role tags `M`, `m` and `o` take precedence over `maintainers`. | Nothing on the server. Report any "not authorized" push rejections to us. |
| NIP-11 and WebSocket upgrades answered on any path                    | **Only at `/`**                                                                                                                                                                                       | The §1.8 nginx config already sends them there                            |
| Env keys                                                              | None removed or renamed; several new ones (below)                                                                                                                                                     | Keep the env file as it is                                                |

**Key source** (`KEYSRC` from §1.3). Do the one case that applies:

```bash
. /root/ngit-upgrade/vars.sh
for v in U BIN W S FP G R B KEYSRC; do [ -n "${!v}" ] || echo "MISSING $v - stop"; done
install -d -m 0755 "/etc/systemd/system/$U.d"
case "$KEYSRC" in
  file)
    chown "$S": "$W/.relay-owner.nsec" && chmod 0600 "$W/.relay-owner.nsec" && echo KEYFILE-READY ;;
  env)
    echo "nothing to change; NGIT_RELAY_OWNER_NSEC must stay set and non-empty" ;;
  flag-literal)
    # Move the key from the unit into the key file without printing it. A pre-existing key file may be a stale, different key, so move it aside first.
    [ -f "$W/.relay-owner.nsec" ] && mv "$W/.relay-owner.nsec" "$B/stale-relay-owner.nsec"
    systemctl cat "$U" | grep -E '^ExecStart=.*--relay-owner-nsec' | tail -1 | sed -nE 's/.*--relay-owner-nsec[= ]+"?([^" ]+)"?.*/\1/p' | install -o "$S" -m 0600 /dev/stdin "$W/.relay-owner.nsec"
    sudo -u "$S" grep -cxE '(nsec1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})' "$W/.relay-owner.nsec"   # shape only; must print 1
    ;;
  flag-file)
    printf '[Service]\nLoadCredential=relay_owner_nsec:%s\n' "$KEYFLAGFILE" > "/etc/systemd/system/$U.d/45-ngit-key.conf" && echo CREDENTIAL-READY ;;
  flag-variable)
    echo "only continue if that variable is NGIT_RELAY_OWNER_NSEC; otherwise stop and tell us" ;;
  *) echo "UNKNOWN KEYSRC - stop" ;;
esac
```

In the `flag-literal` case, if the shape check prints `0`, stop: delete the file it wrote, move `$B/stale-relay-owner.nsec` back if there was one, and tell us.

For **all three `flag-` cases**, remove the flag and its value from whichever unit file holds it, without printing it, and prove it is gone:

```bash
. /root/ngit-upgrade/vars.sh
for f in "$FP" $(systemctl show -p DropInPaths --value "$U"); do grep -q -- '--relay-owner-nsec' "$f" && sed -i -E 's/[[:space:]]+--relay-owner-nsec[= ]+("[^"]*"|[^[:space:]]+)//' "$f"; done
systemctl daemon-reload
systemctl show -p ExecStart --value "$U" | grep -c -- '--relay-owner-nsec'                  # must print 0
grep -lE 'nsec1[02-9ac-hj-np-z]{58}' "$FP" $(systemctl show -p DropInPaths --value "$U")    # must print nothing
```

Then record the new source: `flag-literal` becomes `file`, `flag-file` becomes `credential`, and `flag-variable` becomes `env`. Record it with `printf 'KEYSRC=%q\n' <new value> >> /root/ngit-upgrade/vars.sh`.

**Tell us if the key was on the command line.** Every local account could read it through the process list and the world-readable unit file. We will decide with you whether to rotate it.

**Env additions and decisions.** Put them in one drop-in, and report key names only:

```bash
. /root/ngit-upgrade/vars.sh
{
  printf '[Service]\n'
  printf 'Environment=NGIT_TRUSTED_PROXY_CIDRS=127.0.0.1/32\n'   # only if §1.2 showed a loopback bind; add ,::1/128 if nginx connects over [::1]
  # printf 'Environment=NGIT_USER_INDEX_RELAYS=\n'              # optional opt-out, see below
  # printf 'Environment=NGIT_SYNC_PLUS_ENABLED=false\n'         # optional opt-out, see below
} > "/etc/systemd/system/$U.d/50-ngit-v3.conf"
systemctl daemon-reload
sudo -u "$S" env PATH=<the unit PATH, or /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin> git --version   # git visible to the service
```

- **`NGIT_TRUSTED_PROXY_CIDRS`**: recommended. With it, v3's per-IP connection policy and its logs see the real client addresses instead of 127.0.0.1.
  - Set it only if the backend listens on loopback, or is firewalled so that only nginx can reach it.
  - An invalid CIDR stops startup.
  - Your env file must not also set it, because an `EnvironmentFile=` value overrides `Environment=`.
- **An empty `KEY=` line is not the same as "unset".** Unset means no line at all.
  - An empty `NGIT_STARTUP_INTEGRITY_IDENTIFIERS=`, `NGIT_TRUSTED_PROXY_CIDRS=` or `NGIT_BASE_PATH=` **stops startup**. Only `NGIT_USER_INDEX_RELAYS=` and `NGIT_SYNC_PLUS_FALLBACK_RELAYS=` are valid empty opt-outs.
  - This check must print nothing:

    ```bash
    grep -nE '^[[:space:]]*(export[[:space:]]+)?NGIT_(STARTUP_INTEGRITY_IDENTIFIERS|TRUSTED_PROXY_CIDRS|BASE_PATH)=[[:space:]]*("")?[[:space:]]*$' "$E" "$DOTENV" 2>/dev/null | cut -d= -f1
    ```

- **These must stay unset:**
  - `NGIT_STARTUP_INTEGRITY_IDENTIFIERS`: it narrows the security sweep.
  - `NGIT_BASE_PATH`: leave it unset or set to `/`. Any other value disables NIP-05 and moves the relay off the root.
  - `NGIT_SYNC_ALLOW_NON_GLOBAL_TARGETS`: its default of false is the SSRF protection.
- **Decide, and tell us what you chose.** Either choice works for BIES Code. v3 turns on GRASP-03 "Sync+" by default. At startup it also publishes a kind-0 profile (name = domain, nip05 `_@git.buildinelsalvador.com`) and a kind-10002 relay list for the relay key. They go to wss://purplepag.es, wss://index.hzrd149.com and wss://indexer.coracle.social, and only when no profile exists there yet. There are two opt-outs:
  - `NGIT_USER_INDEX_RELAYS=` (empty) stops the publishing and also Sync+'s NIP-65 discovery.
  - `NGIT_SYNC_PLUS_ENABLED=false` keeps plain GRASP-02 sync.
- **Outbound traffic:** v3 connects out to public relays and git hosts, mostly over TCP 443 (wss and https), for sync and for integrity repair. If the host filters egress, allow this.
- **The owner key is worth more to an attacker than before.** v3 accepts any valid event signed by its own owner key (this is for ngit-ci), and the event blacklist cannot block those events.
- **Connections are unbounded** unless you set `NGIT_MAX_CONNECTIONS`. Also consider `LimitNOFILE`.
- **Keep your existing unit file.** Don't replace it with upstream's `deploy/systemd/ngit-grasp.service`:
  - That unit uses `WorkingDirectory=/var/lib/ngit-grasp`, so it would start an **empty relay under a new identity**, without any error.
  - Its `ProtectSystem=strict`, `ReadWritePaths` and `ProtectHome` settings can also make your current paths read-only or invisible.
- Keep `Type=simple`, because ngit-grasp does not support `sd_notify`.

### 3.3 nginx

This was done in §1.8. If you skipped it, do it now and run its checks, before §3.4.

### 3.4 Install and start

```bash
. /root/ngit-upgrade/vars.sh
for v in U BIN W S G R B KEYSRC; do [ -n "${!v}" ] || echo "MISSING $v - stop"; done
install -m 0755 <NEW_BINARY> "$BIN"            # same path as before
(cd / && "$BIN" --version)                      # ngit-grasp 3.0.5
# Identity guards. v3 loads its key before logging starts, so the journal never says which key it used; these checks are the protection.
WD=$(systemctl show -p WorkingDirectory --value "$U"); [ "${WD:-/}" = "$W" ] && echo WORKDIR-OK
case "$KEYSRC" in
  file) sudo -u "$S" grep -cxE '[[:space:]]*(nsec1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})[[:space:]]*' "$W/.relay-owner.nsec" ;;   # must print 1
  credential) systemctl show -p LoadCredential --value "$U" | grep -q relay_owner_nsec && echo CREDENTIAL-OK ;;
  env) echo "env source: confirmed set and non-empty in §1.3" ;;
  *) echo "UNKNOWN KEYSRC - stop" ;;
esac
systemctl show -p ExecStart --value "$U" | grep -c -- '--relay-owner-nsec'    # must print 0
KEYSTAT=$(stat -c '%i %Y' "$W/.relay-owner.nsec" 2>/dev/null || echo ABSENT)
START=$(date '+%Y-%m-%d %H:%M:%S')
printf '%s=%q\n' KEYSTAT "$KEYSTAT" START "$START" >> "$V"
```

Start it only if every guard passed:

```bash
. /root/ngit-upgrade/vars.sh
systemctl start "$U"; sleep 5
P=$(systemctl show -p MainPID --value "$U"); [ "$(readlink -f /proc/$P/cwd)" = "$W" ] && echo CWD-OK
NOW=$(stat -c '%i %Y' "$W/.relay-owner.nsec" 2>/dev/null || echo ABSENT)
[ "$NOW" = "$KEYSTAT" ] && echo KEY-UNCHANGED || { systemctl stop "$U"; echo "KEY FILE CREATED OR REPLACED: service stopped. Contact us."; }
```

- **If `KEY-UNCHANGED` is missing, v3 generated a new identity.** Once the migration finishes it would publish that identity, before it starts serving, so a later NIP-11 check could only confirm the damage, not prevent it.
  1. Keep the service stopped.
  2. Move `$W/.relay-owner.nsec` to `$B/wrongly-generated.nsec`. Never print it.
  3. Fix the key source and run the guards again. The migration resumes where it stopped.
- **If `CWD-OK` is missing,** the service may already have exited with an error; check §3.5 first.

### 3.5 Watching the first start

Don't use `journalctl -f`. Run this block, and repeat it every few minutes until it shows `Starting HTTP server on`:

```bash
. /root/ngit-upgrade/vars.sh
systemctl show -p ActiveState,SubState,NRestarts "$U" | paste -sd' '
journalctl -u "$U" --since "$START" --no-pager -o cat | grep -E 'Starting ngit-grasp|Configuration loaded|Git data directory:|Relay data directory:|storage migration completed|Batch-migrating|Starting HTTP server on|startup pass completed|^Error|refusing lossy|upgrade Git repositories' | cut -c1-400
echo "families built: $(find "$G/.grasp/families" -mindepth 2 -maxdepth 2 -name '*.git' 2>/dev/null | wc -l) of about $EXPECTED"
```

The normal sequence is:

1. `Starting ngit-grasp`, `Configuration loaded and validated`, `Git data directory: …` and `Relay data directory: …`. The two data directories **must be `$G` and `$R`** (a relative path is relative to `$W`); if not, stop the service and tell us. Then `Database backend: …`.
2. **Then silence for the whole migration.** No per-repository progress is logged. The `families built` count is the only progress indicator.
3. `Git identifier-family storage migration completed`, with counts. This line appears only when there was work to do.
4. Possibly `Batch-migrating historical deletion-request lifecycles`. That is expected.
5. `Starting HTTP server on <addr>`. The relay is back, and you can end the outage notice. The §3.6 sign-off can still take much longer.
6. Later, with the relay already online: `Git storage-integrity startup pass completed` and `Git authorization-integrity startup pass completed`, each with counts.

**If `NRestarts` is above 0, or any `Error` line appears** (for example `upgrade Git repositories to identifier-family storage` or `uses an unknown alternate; refusing lossy migration`):

- The unit's `Restart=` setting would just retry every 10 s and fail the same way. Run `systemctl stop "$U"`, save the lines, and send them to us.
- The migration keeps a journal, so restarting the _same 3.0.5_ later resumes where it stopped.
- **Never start 1.2.0 on a partly or fully migrated tree.** If you need to go back, use §7.

The migration is crash-safe, but don't stop it without a reason: a stop only makes the window longer.

### 3.6 Done means

- The storage summary shows `unresolved=0` and `failed=0`.
- The authorization summary shows `manual_inspection=0` and `failed=0`. Also send us its `repair_needed`, `refs_updated` and `refs_deleted` counts.

Every non-zero count has an `ERROR` line naming the identifier (and, for authorization, the view and ref); send us all of them. Do not delete anything under `<G>/.grasp/migration/` while any family reports `unresolved` above 0.

```bash
. /root/ngit-upgrade/vars.sh
journalctl -u "$U" --since "$START" --no-pager -o cat | grep -E 'Git data directory:|Relay data directory:|storage migration completed|Starting HTTP server on|startup pass completed'
journalctl -u "$U" --since "$START" --no-pager -o cat | grep -cE '\bERROR\b'
```

### 3.7 If it runs in Docker or Podman instead

The sequence is the same, with these differences:

- **Stopping:** use `docker stop -t 300 <name>`, because the 10 s default is too short. In compose, set `stop_grace_period: 5m`.
- **Finding mounts:** use `docker container inspect --format '{{json .Mounts}}' <name>`. That template prints only the mounts; a plain `inspect` prints the environment too. Snapshot those mount sources in §2.3.
- **Image:**
  - Build it yourself from the verified v3.0.5 checkout, for example `docker build --build-arg NGIT_BUILD_REVISION=66611985d72cdd1f7e6b67f173b02f8c9a4d7af6 -t ngit-grasp:3.0.5 .`.
  - Or use upstream's `ncontainer.io/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit-grasp:3.0.5`. It is published over Nostr, so check that your host can pull it.
- **Upstream image layout:** Debian bookworm-slim with git, `WORKDIR /data`, git data at `/data/git`, relay data at `/data/relay`, and the key at `/data/.relay-owner.nsec`. The container runs as **uid/gid 10001**.
- **Ownership:** the entrypoint chowns only the top-level directories and the key, not everything inside them. If your data is owned by a different uid, run `chown -R 10001:10001` on it **after** the snapshot and before the first start, or the migration's writes will fail.
- **Binding and client addresses:**
  - Inside the container the entrypoint binds `0.0.0.0`, so publish only on loopback: `-p 127.0.0.1:7334:7334`. Docker publishes bypass UFW, and a public publish would expose `/metrics` and the raw relay.
  - Behind docker-proxy, the relay sees the bridge gateway (for example `172.17.0.1`) as its peer, so set `NGIT_TRUSTED_PROXY_CIDRS` to that `/32`, not to `127.0.0.1/32`.
- **Mount paths inside the container** must never change from now on, for the reason in §1.4.
- **Host-side git loops:** after the migration, run the §4.3 loops inside the container, for example `docker exec -u 10001 <name> sh -c '…'`. Each repository's `alternates` file holds the in-container path, so git on the host sees repositories with no objects.
- **Healthchecks:** upstream's compose healthcheck marks the container unhealthy during a long migration. That is harmless unless something (an "autoheal" container, for example) restarts unhealthy containers; pause it.

### 3.8 Backups from now on

- Archive the **whole** state directory, dot-directories included, for example `tar -C <dir> -cf - .`. Stop the service first, or use an atomic filesystem snapshot. No `mdb_copy`, and no copying while it runs.
- The git data, relay data and key must come from one point in time.
- Check that `.grasp/families` and `.grasp/storage-version` appear in every backup's listing.
- Restore only to the **same absolute path**.
- No git gc, repack or prune, ever.
- Delete the pre-v3 snapshot from §2.3 when the rollback period ends.

### 3.9 If the host is NixOS

Upstream shipped 1.2.0 with a NixOS module as its only packaged deployment. The unit is `ngit-grasp-<name>.service`.

**Differences from the steps above:**

- Skip the key-source edits in §3.2, the `install` in §3.4, and every unit-file edit.
- `/etc/systemd/system` is read-only. For the §2.1 stop timeout, use a runtime drop-in instead: put the same `40-ngit-stop-timeout.conf` in `/run/systemd/system/$U.d/`, then run `systemctl daemon-reload`.
- Under 1.2.0 with `relayOwnerNsecFile`, the module passes the key on the **command line**. The "don't run" list in the ground rules matters doubly here.

**Steps:**

1. **Preparation:** pin the flake input to the tag and commit, for example `git+https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit-grasp.git?ref=refs/tags/v3.0.5&rev=66611985d72cdd1f7e6b67f173b02f8c9a4d7af6`.
   - Then run `nix flake update <input>`, or `nix flake lock --update-input <input>` on older Nix.
   - Check that `jq -r '.nodes["<input>"].locked.rev' flake.lock` prints `66611985d72cdd1f7e6b67f173b02f8c9a4d7af6`.
2. **Keep `services.ngit-grasp.<name>.dataDir` and `relayOwnerNsecFile` unchanged.** The 3.0.5 module passes that file as the systemd credential `relay_owner_nsec`, so the identity is kept.
   - Never switch to `relayOwnerNsec`, which puts the key in the world-readable Nix store.
   - If you already use `relayOwnerNsec`, tell us; the key is already exposed.
3. **Optional settings:**
   - `trustedProxyCidrs = [ "127.0.0.1/32" ];`
   - `userIndexRelays = [ ];` and/or `syncPlusEnabled = false;` (the §3.2 decision)
   - `systemd.services."ngit-grasp-<name>".serviceConfig.TimeoutStopSec = "300s";` (the 3.0.5 module leaves the 90 s default)
4. Run `nixos-rebuild build` **before the window** to catch evaluation and build errors.
5. **In the window:**
   1. Do §2.1–2.3 with `U=ngit-grasp-<name>.service`, and `W` equal to `dataDir`. `G` and `R` are `dataDir/git` and `dataDir/relay`.
   2. Record `KEYSTAT` and `START` as in §3.4.
   3. Run `nixos-rebuild switch`. If `systemctl is-active "$U"` is not `active` afterwards, run `systemctl start "$U"`.
   4. Run the §3.4 post-start checks at once. `KEYSRC` is `credential`: the key file must stay `ABSENT`, and `CREDENTIAL-OK` must print.
   5. Continue with §3.5.
6. **Rollback:**
   1. Stop the unit.
   2. Restore the snapshot as in §7.3, skipping the binary and unit-file lines.
   3. Run `nixos-rebuild switch --rollback`, which starts 1.2.0 again.

---

## 4. Verify ngit-grasp

### 4.1 NIP-11 and identity

```bash
. /root/ngit-upgrade/vars.sh
curl -s -H 'Accept: application/nostr+json' "$H/" > "$B/nip11-after.json"; jq '{version,pubkey,supported_nips,supported_grasps,limitation}' "$B/nip11-after.json"
a=$(jq -er .pubkey "$B/nip11-before.json") && b=$(jq -er .pubkey "$B/nip11-after.json") && [ "$a" = "$b" ] && echo PUBKEY-UNCHANGED || echo "PUBKEY CHECK FAILED: stop the service and contact us"
n=$(curl -s "$H/.well-known/nostr.json" | jq -er '.names._') && [ "$n" = "$(jq -er .pubkey "$B/nip11-after.json")" ] && echo NIP05-OK
curl -sI "$H/icon.png" | grep -i '^content-type: image/png'
```

Expected results:

- `version` is `3.0.5-66611985` for a build from the git tag or Nix, or a bare `3.0.5` for a crates.io build.
- `supported_nips` is `[1,5,9,11,34,62,77]`.
- `supported_grasps` includes `GRASP-01`, `GRASP-02` and `GRASP-03`. GRASP-03 is missing if you disabled Sync+. GRASP-05 and GRASP-06 appear only if you configured them.
- There is a `limitation` object with `max_limit` 500.

### 4.2 WebSocket, and the bies-code announcement and state

```bash
. /root/ngit-upgrade/vars.sh
curl -s --http1.1 --max-time 5 -o /dev/null -D - -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$H/" | head -1   # HTTP/1.1 101
nak req -k 30617 -k 30618 -t d=bies-code wss://git.buildinelsalvador.com | jq -c '{kind,pubkey,created_at}'
# or, with websocat:
(printf '%s\n' '["REQ","v",{"kinds":[30617,30618],"#d":["bies-code"]}]'; sleep 5) | websocat -t wss://git.buildinelsalvador.com/ | jq -c 'select(.[0]=="EVENT") | .[2] | {kind,pubkey,created_at}'
```

You should see at least one kind **30617** and at least one kind **30618** event, authored by our pubkey. `nak decode $NPUB` gives its hex form.

### 4.3 Git, repository count, refs and objects

```bash
. /root/ngit-upgrade/vars.sh
git ls-remote "$H/$NPUB/bies-code.git" > "$B/bies-code-refs-after.txt"
[ -s "$B/bies-code-refs-before.txt" ] && [ -s "$B/bies-code-refs-after.txt" ] && cmp "$B/bies-code-refs-before.txt" "$B/bies-code-refs-after.txt" && echo REFS-UNCHANGED
d=$(mktemp -d) && git clone --mirror "$H/$NPUB/bies-code.git" "$d/bies-code.git" && git -C "$d/bies-code.git" fsck --full --no-dangling && echo FSCK-OK; rm -rf -- "$d"
find "$G" -mindepth 2 -maxdepth 3 -type d -name '*.git' ! -path "$G/.*" | wc -l; cat "$B/repo-count-before.txt"
test -f "$G/.grasp/storage-version" && echo MIGRATED
(cd "$G" && for r in npub1*/*.git prs/*/*.git; do [ -d "$r" ] || continue; printf '%s %s\n' "$(sudo -u "$S" git --git-dir="$r" for-each-ref --format='%(objectname) %(refname)' | sha256sum | cut -c1-16)" "$r"; done) > "$B/refs-after.txt"
[ -s "$B/refs-before.txt" ] && diff "$B/refs-before.txt" "$B/refs-after.txt" && echo ALL-REFS-UNCHANGED
curl -so /dev/null -w '%{http_code}\n' "$H/metrics"                  # 404 publicly
curl -s http://<GRASP_UPSTREAM>/metrics | head -3                     # Prometheus text if metrics are enabled, otherwise 404; never HTML
nak req -k 30617 -l 500 wss://git.buildinelsalvador.com 2>/dev/null | wc -l; cat "$B/ann-count-before.txt"   # optional; v3 caps a filter at 500
```

- **Repository count:** it must be equal. It may be lower only by zero-ref `/prs/` repositories that GRASP-06 startup recovery removed and logged.
- **Changed refs:** for any ref that changed, send us the differing lines together with the authorization summary line. **Do not roll back over ref differences alone.** The authorization pass repairs refs that the signed events do not authorize, and we will tell you whether a difference is one of those.

**Recommended:** after both startup summaries have appeared, check that every repository's objects survived the migration. This runs while the relay is online and can take a while on a large host.

```bash
. /root/ngit-upgrade/vars.sh
(cd "$G" && for r in npub1*/*.git prs/*/*.git; do [ -d "$r" ] || continue; sudo -u "$S" git --git-dir="$r" fsck --connectivity-only --no-dangling --no-progress >/dev/null 2>&1 || echo "CONN-FAIL $r"; done) | tee "$B/conn-after.txt"; wc -l < "$B/conn-after.txt"
```

The count must be 0, or match the FSCK-FAIL lines from §1.4.

**Optional:** upstream's own checker, `VERIFY_METRICS=false sh scripts/verify-deployment.sh https://git.buildinelsalvador.com`. Run it from the v3.0.5 source checkout, as an unprivileged user, on any machine. It only makes read requests, and §4.1–4.2 cover the same ground.

### 4.4 Integrity (mandatory if GRASP-06 was ever enabled)

If GRASP-06 was ever on, treat the hosted repositories as possibly containing unauthorized objects or refs until the full authorization pass shows `manual_inspection=0 failed=0`. Send us every `ERROR` line. Then also check bies-code explicitly.

The request waits until both startup summaries have appeared, then runs within about 5 seconds.

```bash
. /root/ngit-upgrade/vars.sh
sudo -u "$S" bash -c 'cd "$1" && exec "$2" integrity-check --identifier bies-code --git-data-path "$3"' _ "$W" "$BIN" "$G"   # prints "Queued …"
journalctl -u "$U" --since "$START" --no-pager -o cat | grep -E 'Manual Git (storage|authorization)-integrity request completed'
```

- **Pass criteria:** storage shows `unresolved=0 failed=0`, and authorization shows `repair_needed=0 manual_inspection=0 failed=0`.
- **If repairs are needed:** run the same command with `--repair` added, then run the check-only command again.

### 4.5 Finish the window

1. Re-enable the monitors and restarters you paused in §2.1.
2. Take the first post-upgrade backup the §3.8 way, and check that its listing shows `.grasp/families` and `.grasp/storage-version`.
3. **Tell us that §4 passed.** We will make a test push to bies-code from a maintainer key and confirm. Run §5.4 after our confirmation.

---

## 5. BIES Code: build, then deploy

Do §5.1–5.3 **before the window**, as a normal user (not root), outside the web root, preferably not on the server. Do §5.4 **only after §4 passes and we have confirmed the test push**.

### 5.1 Toolchain

- **Node.js 22 LTS** (we build with v22.22.0), plus **pnpm 9.15.9** through corepack. The repository's `packageManager` field pins that version.
- **Never build with npm.** `npm install` silently ignores pnpm's `patchedDependencies`, which carry patches to the applesauce libraries. One of those patches stops the app from retrying unreachable relays every second.
- The build needs network access to registry.npmjs.org and to codeload.github.com, because one dependency is a GitHub tarball.
- Build from a **git checkout**, not a zip or tarball. The build embeds the commit hash and date; without git it embeds `unknown` and produces a different bundle.

### 5.2 Fetch the pinned commit

```bash
git clone https://github.com/SovereignTechnology/bies-code.git bies-code && cd bies-code
git checkout --detach 061cbe31d05825527327a65134e1820f5656dea6
test "$(git rev-parse HEAD)" = "061cbe31d05825527327a65134e1820f5656dea6" && echo SHA-OK
git config core.abbrev 12       # the build embeds the short commit hash; this fixes its length so your bundle matches ours
```

Other sources work too, followed by the same SHA check:

- `git clone https://git.buildinelsalvador.com/npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/bies-code.git` with plain git, but only while the relay is up.
- `git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.buildinelsalvador.com/bies-code`, which needs ngit's `git-remote-nostr`.

### 5.3 Build and cross-check

```bash
corepack enable                 # use sudo if Node is installed system-wide
node --version                  # v22.x
pnpm --version                  # 9.15.9
pnpm install --frozen-lockfile
env -u APP_RELEASE_VERSION pnpm build                               # writes dist/ (including dist/404.html)
grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"' dist/index.html    # must be exactly src="/assets/index-Di6sUX0Q.js"
grep -o '<title>[^<]*</title>' dist/index.html                       # <title>BIES Code - Decentralized Git</title>
test ! -e dist/.well-known/nostr.json && echo NO-STATIC-NOSTR-JSON
git status --short                                                   # must print nothing
(cd dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum    # must equal 44910af6c41aa2f8214b5f2348d48de75c2da2c4341c653befd74054b4afb708
```

We computed `index-Di6sUX0Q.js` and the dist digest `44910af6c41aa2f8214b5f2348d48de75c2da2c4341c653befd74054b4afb708` the same way, in two independent builds (Node v22.22.0, pnpm 9.15.9) that matched byte for byte: from a fresh clone of the GitHub repository at `061cbe31d05825527327a65134e1820f5656dea6`, with `core.abbrev 12` and without `APP_RELEASE_VERSION`.

**If the bundle name differs, don't deploy.** Send us the output of `node --version`, `pnpm --version`, `git rev-parse HEAD` and `git status --short`, plus the bundle name you got.

If we sent you a `dist` tarball with a sha256 instead, check it with `sha256sum`, unpack it, run the same `grep` checks on its `index.html`, and continue with §5.4.

### 5.4 Deploy with an atomic switch (after §4 and our confirmation)

Copy `dist` to the server if you built it elsewhere, for example with `scp -r` or `rsync -a`. Then:

```bash
. /root/ngit-upgrade/vars.sh
DIST=<DIST_DIR>
(cd "$DIST" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum    # must equal the §5.3 digest
NEW="$RELS/061cbe31d05825527327a65134e1820f5656dea6"
install -d -m 0755 "$NEW"
cp -a "$RELS/july-CTKe40JK/assets" "$NEW/assets"     # old chunks first, for browser tabs still running the July build
cp -a "$DIST"/. "$NEW/"                               # then the new build on top
chown -R root:root "$NEW" && chmod -R u=rwX,go=rX "$NEW"
grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"' "$NEW/index.html"      # src="/assets/index-Di6sUX0Q.js"
ln -sfn "061cbe31d05825527327a65134e1820f5656dea6" "$RELS/current.new" && mv -T "$RELS/current.new" "$RELS/current"
```

- The nginx config is **unchanged** in this step, so no reload is needed. The one exception is when §1.6 found `open_file_cache`: then run `nginx -t && systemctl reload nginx` so the switch applies at once.
- Keep `july-CTKe40JK` as the rollback target.
- The copied July chunks can be dropped at the next deploy.

---

## 6. Verify the web app

```bash
. /root/ngit-upgrade/vars.sh
curl -s "$H/" | grep -o '<title>[^<]*</title>'                                          # BIES Code - Decentralized Git
curl -s "$H/" | grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"'                       # src="/assets/index-Di6sUX0Q.js"
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/assets/index-Di6sUX0Q.js"     # 200 application/javascript (or text/javascript)
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/assets/index-CTKe40JK.js"           # 200 (old chunk kept)
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/assets/does-not-exist.js"           # 404, never "200 text/html"
curl -so /dev/null -w '%{http_code} %{content_type}\n' "$H/$NPUB/bies-code"                    # 200 text/html (app deep link)
curl -s "$H/$NPUB/bies-code" | grep -oE 'src="/assets/index-[A-Za-z0-9_-]+\.js"'        # the same bundle
curl -sI "$H/" | grep -i '^cache-control'                                                # no-cache
curl -s -H 'Accept: application/nostr+json' "$H/" | jq -r .version                       # still 3.0.5… on the same hostname
curl -s --http1.1 --max-time 5 -o /dev/null -D - -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$H/" | head -1   # 101
curl -s "$H/.well-known/nostr.json" | jq -e '.names._' >/dev/null && echo NIP05-JSON     # JSON, not the app's HTML
```

**In a browser**, using a private window, open https://git.buildinelsalvador.com/ and check that:

- the repository list loads and includes **bies-code**;
- opening bies-code shows its files and history;
- the devtools console shows **no** `Failed to fetch dynamically imported module` errors and no CSP errors.

---

## 7. Rollback

### 7.1 BIES Code only (instant and safe)

```bash
. /root/ngit-upgrade/vars.sh
ln -sfn july-CTKe40JK "$RELS/current.new" && mv -T "$RELS/current.new" "$RELS/current"
```

### 7.2 nginx only

```bash
. /root/ngit-upgrade/vars.sh
cp -a "$B/vhost-before.conf" <VHOST_FILE>
nginx -t && systemctl reload nginx
```

The old vhost points `root` back at `<WEBROOT>`, which still holds the July build. The `map` line in the `http {}` context is harmless and can stay.

### 7.3 ngit-grasp: the migration is ONE-WAY

A rollback means **restoring the whole snapshot together with the old binary and unit**. Installing the old binary alone is not enough, and 1.2.0 (or any 2.x) must never start against the migrated tree, even though clones may appear to work. Know the cost before you start:

- Anything pushed or published after the upgrade is **lost**.
- Rolling back **re-opens the path-traversal hole**. Use it only as a last resort, and tell us right away.
- **Roll BIES Code back first (§7.1)**, because the new app must not run against 1.2.0.
- You need free space for the extracted snapshot, since the migrated tree is moved aside, not deleted.

```bash
. /root/ngit-upgrade/vars.sh
for v in U BIN FP G R B; do [ -n "${!v}" ] || echo "MISSING $v - stop"; done
systemctl stop "$U"; systemctl is-active "$U"                 # inactive or failed
pgrep -x ngit-grasp || echo "no ngit-grasp process"
sha256sum -c "$B/ngit-state-pre-v3.tar.gz.sha256"
SUF=v3-rollback-$(date -u +%s)
( set -e
  for d in "$G" "$R"; do
    [ -e "$d" ] || continue
    if mountpoint -q "$d"; then echo "$d is a mount point: stop here and contact us"; exit 1; fi
    mv -T "$d" "$d.$SUF"
  done
  for d in "$G" "$R"; do [ ! -e "$d" ] || { echo "STILL PRESENT $d"; exit 1; }; done
  tar --sparse -C / -xzpf "$B/ngit-state-pre-v3.tar.gz"      # restores the SAME absolute paths, owners and modes, and the key file
) && echo RESTORE-OK
```

**Do not continue without `RESTORE-OK`.** Then restore the binary and the unit exactly as they were:

```bash
. /root/ngit-upgrade/vars.sh
for v in U BIN FP B; do [ -n "${!v}" ] || echo "MISSING $v - stop"; done
install -m 0755 "$B/ngit-grasp-1.2.0" "$BIN"
cp -a "$B/$(basename "$FP")" "$FP"
rm -rf -- "/etc/systemd/system/$U.d"; [ -d "$B/unit-dropins-before" ] && cp -a "$B/unit-dropins-before" "/etc/systemd/system/$U.d"
[ -n "$E" ] && [ -f "$B/$(basename "$E")" ] && cp -a "$B/$(basename "$E")" "$E"
systemctl daemon-reload
systemctl start "$U"
curl -s -H 'Accept: application/nostr+json' "$H/" | jq '{version,pubkey}'      # 1.2.0, with the original pubkey
```

The §1.8 nginx locations do no harm under 1.2.0 and can stay. Keep the moved-aside `*.v3-rollback-*` directories until we have agreed the next step.

---

## 8. What to send back to us

Send **no** secrets: not the key, not env values, not the snapshot, and not unit files that carry inline `Environment=`, `SetCredential=` or `--relay-owner-nsec` lines.

1. **Host:**
   - The architecture and OS (§1.1), and whether it is NixOS.
   - `git --version`, both as root and as the service user, and `nginx -v`.
   - Whether the service runs under systemd, a container or NixOS.
   - The unit name and the binary path.
   - The `cgroup` line, and the backend listen address (§1.2).
2. **The 1.2.0 installation:**
   - How it had been installed (Nix, cargo install, or other).
   - `WorkingDirectory`, and `KEYSRC` as it was before §3.2.
   - The **key names** of the env file(s), of any `.env`, and of inline `Environment=` lines.
   - The allow-listed values from §1.3, including `NGIT_GRASP06_ENABLE`.
3. **Pre-flight:**
   - The journal data-directory lines and `G`/`R`.
   - The `ls -A` names of `$W` and `$G`.
   - The repository and identifier counts, the `du` of the git and relay data, and the largest family.
   - The output of the four "must print nothing" checks, and any FSCK-FAIL lines.
   - Anything found in §1.5, including backup jobs you changed.
   - The certbot authenticator, and whether a CDN sits in front.
4. **§1.8:** the vhost diff (`diff -u "$B/vhost-before.conf" <VHOST_FILE>`, once you have checked it holds no credentials), and the outputs of the checks after the reload.
5. **Snapshot:**
   - The file name, size and **sha256**, and the three `grep -c` counts from §2.3.
   - The stop `Result` from §2.2.
   - The rehearsal duration and output, if you did one.
6. **How you got 3.0.5:** A, A2, B, C, a container or NixOS (with the flake-lock rev), the binary's **sha256**, and its `--version` output.
7. **§3.2:**
   - The key-source case you applied, and whether the key had been on the command line.
   - The names of the env keys you added.
   - Your Sync+ and identity-publishing decision.
8. **First start:**
   - `START`, the time of `Starting HTTP server on`, and the times of both summaries.
   - `WORKDIR-OK`, `CWD-OK` and `KEY-UNCHANGED`.
   - The data-directory lines, the migration-completed line, and both integrity summary lines verbatim.
   - The `ERROR` count, and every `ERROR` line if there are any.
9. **The §4 outputs:**
   - NIP-11 before and after (version, pubkey, nips, grasps), `PUBKEY-UNCHANGED` and `NIP05-OK`.
   - The WebSocket status line and the 30617/30618 output.
   - `REFS-UNCHANGED` and `ALL-REFS-UNCHANGED`, or the differing lines.
   - `FSCK-OK`, the repository counts before and after, and the connectivity-check count.
   - The §4.4 results, if you ran them.
10. **BIES Code:** `node --version`, `pnpm --version`, `git rev-parse HEAD`, the built bundle name, the dist digest, the §6 outputs, and the browser check.
11. **Deviations:** any step you skipped or changed, and why. Any push rejected with "not authorized" after the upgrade.

import { Command, InvalidArgumentError } from "commander";
import { ARCHIVE_SLICES, findArchives, importArchive } from "./archive.js";
import { exportBackup, importBackup, syncBackup, validateBackup } from "./backup.js";
import { ensureDirs, loadConfig, setHomeOverride, updateConfig } from "./config.js";
import { defaultAccount, getDb, rebuildFts, seedDemoData } from "./db.js";
import {
  getAnalysisStatus,
  retryFailedAnalysis,
  runAnalysis,
} from "./analysis.js";
import {
  graphComment,
  graphPublish,
  graphReplyToComment,
  graphSendMessage,
} from "./graph.js";
import { authStatus, runWebAction, syncLive, uploadWebPhoto, webWhoAmI } from "./live.js";
import { fetchMedia } from "./media.js";
import {
  addBoardItems,
  addPostsToCollection,
  createBoard,
  createLibraryCollection,
  createTag,
  getBoard,
  getLibraryOverview,
  listBoards,
  listDuplicateGroups,
  organizeLibrary,
  tagPosts,
  updateBoardItem,
  visualSearch,
} from "./library.js";
import {
  getInbox,
  getInsights,
  getPost,
  getProfile,
  getStatus,
  getThread,
  graphQuery,
  listPosts,
  listProfiles,
  listThreads,
  searchComments,
  searchDms,
} from "./queries.js";
import { serve } from "./server.js";
import { printValue } from "./utils.js";

export async function runCli(argv) {
  const program = new Command();
  program
    .name("gramclaw")
    .description("Local-first Instagram memory: archive, search, sync, inspect, and act.")
    .version("1.1.0")
    .option("--home <path>", "Override ~/.gramclaw storage")
    .option("--json", "Emit stable JSON")
    .option("--plain", "Disable decorative output")
    .option("--cookie-source <browser>", "Browser cookie source (repeatable)", collect, [])
    .option("--chrome-profile <name-or-path>", "Chrome profile name or path")
    .option("--firefox-profile <name-or-path>", "Firefox profile name or path")
    .option("--cookie-file <path>", "Sweet Cookie JSON export")
    .option("--session-id <value>", "Instagram sessionid cookie")
    .option("--csrf-token <value>", "Instagram csrftoken cookie")
    .option("--user-id <value>", "Instagram ds_user_id cookie")
    .option("--timeout <ms>", "Request timeout", positiveInteger, 30_000);

  program.hook("preAction", (rootCommand) => {
    const globals = rootCommand.opts();
    if (globals.home) setHomeOverride(globals.home);
  });

  program
    .command("init")
    .description("Create a local Gramclaw workspace")
    .option("--demo", "Seed a realistic offline workspace")
    .action((options, command) => {
      const paths = ensureDirs();
      const db = getDb();
      const demo = options.demo ? seedDemoData(db) : { seeded: false };
      output(command, {
        ok: true,
        demo,
        account: defaultAccount(db),
        rootDir: paths.rootDir,
        dbPath: paths.dbPath,
        nextSteps: options.demo
          ? ["gramclaw serve --open", "gramclaw search posts studio --json"]
          : ["gramclaw import archive <instagram-export.zip>", "gramclaw serve --open"],
      });
    });

  program
    .command("status")
    .description("Show local workspace status")
    .action((_, command) => output(command, getStatus(getDb())));

  const auth = program.command("auth").description("Inspect and configure live transports");
  auth
    .command("status")
    .description("Check browser-cookie and Graph credentials")
    .action(async (_, command) => output(command, await authStatus(globals(command))));
  auth
    .command("whoami")
    .description("Resolve the Instagram account behind browser cookies")
    .action(async (_, command) => output(command, await webWhoAmI(globals(command))));
  auth
    .command("use <transport>")
    .description("Set preferred transport: auto, cookie, graph, or archive")
    .action((transport, _, command) => {
      if (!["auto", "cookie", "graph", "archive"].includes(transport)) throw new InvalidArgumentError("transport must be auto, cookie, graph, or archive");
      output(command, updateConfig((config) => {
        config.transport ??= {};
        config.transport.preferred = transport;
        return config;
      }));
    });

  const archive = program.command("archive").description("Find Instagram data exports");
  archive
    .command("find")
    .description("Find likely exports in Downloads and Desktop")
    .action((_, command) => output(command, { items: findArchives() }));

  const importCommand = program.command("import").description("Import local data");
  importCommand
    .command("archive [path]")
    .description("Import an Instagram JSON export ZIP or directory")
    .option("--select <slices>", `Comma-separated: ${ARCHIVE_SLICES.join(",")}`)
    .option("--restore", "Exactly replace selected archive slices")
    .action(async (path, options, command) => {
      const selectedPath = path ?? findArchives()[0]?.path;
      if (!selectedPath) throw new Error("No Instagram archive found. Pass a path or place the ZIP in Downloads.");
      output(command, await importArchive(selectedPath, {
        select: options.select?.split(","),
        restore: options.restore,
      }));
    });
  importCommand
    .command("backup <path>")
    .description("Merge a Gramclaw JSONL backup into SQLite")
    .option("--restore", "Replace portable local rows exactly")
    .action((path, options, command) => output(command, importBackup(path, options)));

  program
    .command("sync <stream>")
    .description("Sync profile, posts, timeline, saved, liked, comments, DMs, followers, or following")
    .option("--mode <mode>", "auto, cookie, or graph", "auto")
    .option("--limit <count>", "Maximum records", positiveInteger, 100)
    .option("--max-pages <count>", "Maximum pages", positiveInteger, 5)
    .option("--cursor <cursor>", "Resume cursor")
    .action(async (stream, options, command) => {
      const allowed = ["profile", "posts", "timeline", "saved", "liked", "comments", "dms", "followers", "following"];
      if (!allowed.includes(stream)) throw new InvalidArgumentError(`stream must be one of: ${allowed.join(", ")}`);
      output(command, await syncLive(stream, { ...globals(command), ...options }));
    });

  const search = program.command("search").description("Full-text local search");
  search
    .command("posts <query...>")
    .description("Search captions")
    .option("--kind <kinds>", "post, carousel, reel, story")
    .option("--author <username>", "Filter by author")
    .option("--since <date>", "Earliest ISO date")
    .option("--until <date>", "Latest ISO date")
    .option("--saved", "Only saved posts")
    .option("--liked", "Only liked posts")
    .option("--own", "Only your own posts")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((query, options, command) => output(command, listPosts(getDb(), { ...options, query: query.join(" ") })));
  search
    .command("dms <query...>")
    .description("Search direct message text")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((query, options, command) => output(command, { items: searchDms(getDb(), query.join(" "), options) }));
  search
    .command("comments <query...>")
    .description("Search comments")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((query, options, command) => output(command, { items: searchComments(getDb(), query.join(" "), options) }));
  search
    .command("visual <query...>")
    .description("Ask natural-language questions across captions, OCR, colors, objects, and visual embeddings")
    .option("--kind <kinds>", "post, carousel, reel, story")
    .option("--author <username>", "Filter by author")
    .option("--since <date>", "Earliest ISO date")
    .option("--until <date>", "Latest ISO date")
    .option("--saved", "Only saved posts")
    .option("--liked", "Only liked posts")
    .option("--color <name>", "Filter by dominant color")
    .option("--topic <topic>", "Require a topic")
    .option("--limit <count>", "Maximum results", positiveInteger, 80)
    .action((query, options, command) => output(command, visualSearch(getDb(), query.join(" "), options)));

  program
    .command("ask <query...>")
    .description("Natural-language visual search")
    .option("--limit <count>", "Maximum results", positiveInteger, 80)
    .action((query, options, command) => output(command, visualSearch(getDb(), query.join(" "), options)));

  const posts = program.command("posts").description("Read local posts");
  posts
    .command("list")
    .description("List posts")
    .option("--kind <kinds>", "Filter by kind")
    .option("--author <username>", "Filter by author")
    .option("--own", "Only your posts")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((options, command) => output(command, listPosts(getDb(), options)));
  posts
    .command("read <id-or-shortcode>")
    .description("Read one post with media and comments")
    .action((id, _, command) => {
      const result = getPost(getDb(), id);
      if (!result) throw new Error(`Post not found: ${id}`);
      output(command, result);
    });

  for (const [name, collection] of [["saved", "saved"], ["liked", "liked"]]) {
    program
      .command(name)
      .description(`List locally ${name} posts`)
      .option("--limit <count>", "Maximum results", positiveInteger, 50)
      .action((options, command) => output(command, listPosts(getDb(), { ...options, collection })));
  }
  program
    .command("stories")
    .description("List preserved stories")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((options, command) => output(command, listPosts(getDb(), { ...options, kind: "story" })));

  const dms = program.command("dms").description("Read local direct messages");
  dms
    .command("list")
    .description("List conversations")
    .option("--needs-reply", "Only conversations needing a reply")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((options, command) => output(command, { items: listThreads(getDb(), options) }));
  dms
    .command("thread <id>")
    .description("Read a full conversation")
    .option("--limit <count>", "Maximum messages", positiveInteger, 500)
    .action((id, options, command) => {
      const result = getThread(getDb(), id, options);
      if (!result) throw new Error(`DM thread not found: ${id}`);
      output(command, result);
    });

  program
    .command("inbox")
    .description("Rank recent comments and DMs for triage")
    .option("--limit <count>", "Maximum results", positiveInteger, 30)
    .action((options, command) => output(command, { items: getInbox(getDb(), options) }));

  const graph = program.command("graph").description("Query the local follow graph");
  for (const kind of ["summary", "mutuals", "non-mutual-following", "top-followers", "events", "unfollowed"]) {
    graph
      .command(kind)
      .option("--limit <count>", "Maximum results", positiveInteger, 100)
      .option("--since <date>", "Earliest event date")
      .action((options, command) => output(command, graphQuery(getDb(), kind, options)));
  }

  const profiles = program.command("profiles").description("Inspect cached people");
  profiles
    .command("list")
    .option("--query <text>", "Search name, username, or bio")
    .option("--limit <count>", "Maximum results", positiveInteger, 50)
    .action((options, command) => output(command, { items: listProfiles(getDb(), options) }));
  profiles
    .command("show <username-or-id>")
    .action((value, _, command) => {
      const result = getProfile(getDb(), value);
      if (!result) throw new Error(`Profile not found: ${value}`);
      output(command, result);
    });

  program
    .command("insights")
    .description("Summarize local posting history")
    .action((_, command) => output(command, getInsights(getDb())));

  const media = program.command("media").description("Manage the local media cache");
  media
    .command("fetch")
    .option("--post <id>", "Only one post")
    .option("--limit <count>", "Maximum media files", positiveInteger, 200)
    .option("--concurrency <count>", "Parallel downloads", positiveInteger, 3)
    .option("--delay-ms <ms>", "Delay between downloads", positiveInteger, 0)
    .option("--force", "Re-download cached files")
    .action(async (options, command) => output(command, await fetchMedia({
      ...options,
      postId: options.post,
      timeout: globals(command).timeout,
    })));

  const analyze = program.command("analyze").description("Build the private visual index");
  analyze
    .command("run")
    .description("Analyze media with the local engine or optional cloud vision")
    .option("--provider <provider>", "local or cloud", "local")
    .option("--post <id...>", "Only selected posts")
    .option("--limit <count>", "Maximum media items", positiveInteger, 500)
    .option("--force", "Re-analyze completed media")
    .action(async (options, command) => output(command, await runAnalysis({
      provider: options.provider,
      postIds: options.post,
      limit: options.limit,
      force: options.force,
    })));
  analyze
    .command("status")
    .description("Show queue progress and failures")
    .action((_, command) => output(command, getAnalysisStatus(getDb())));
  analyze
    .command("retry")
    .description("Retry failed analysis jobs")
    .option("--provider <provider>", "local or cloud", "local")
    .action(async (options, command) => {
      const db = getDb();
      retryFailedAnalysis(db, options);
      output(command, await runAnalysis({ db, provider: options.provider }));
    });

  const library = program.command("library").description("Organize Saved items into a smart visual library");
  library
    .command("status")
    .action((_, command) => output(command, getLibraryOverview(getDb())));
  library
    .command("organize")
    .description("Refresh automatic topic collections")
    .action((_, command) => output(command, organizeLibrary(getDb())));
  library
    .command("duplicates")
    .description("Find duplicate media")
    .action((_, command) => output(command, { items: listDuplicateGroups(getDb()) }));
  library
    .command("create <name>")
    .description("Create a custom collection")
    .option("--description <text>", "Collection description")
    .option("--color <hex>", "Collection color")
    .option("--post <id...>", "Posts to add")
    .action((name, options, command) => output(command, createLibraryCollection(getDb(), {
      name,
      description: options.description,
      color: options.color,
      postIds: options.post,
    })));
  library
    .command("add <collection-id> <post-ids...>")
    .description("Add posts to a custom collection")
    .action((collectionId, postIds, _, command) => output(command, addPostsToCollection(getDb(), collectionId, postIds)));
  library
    .command("tag <name> <post-ids...>")
    .description("Create a tag and apply it to posts")
    .option("--color <hex>", "Tag color")
    .action((name, postIds, options, command) => {
      const db = getDb();
      const tag = createTag(db, { name, color: options.color });
      output(command, { tag, ...tagPosts(db, tag.id, postIds) });
    });

  const boards = program.command("boards").description("Create and arrange visual moodboards");
  boards
    .command("list")
    .action((_, command) => output(command, { items: listBoards(getDb()) }));
  boards
    .command("create <name>")
    .option("--description <text>", "Board description")
    .option("--background <hex>", "Board background")
    .option("--post <id...>", "Initial posts")
    .action((name, options, command) => output(command, createBoard(getDb(), {
      name,
      description: options.description,
      background: options.background,
      postIds: options.post,
    })));
  boards
    .command("show <board-id>")
    .action((boardId, _, command) => {
      const board = getBoard(getDb(), boardId);
      if (!board) throw new Error("Board not found.");
      output(command, board);
    });
  boards
    .command("add <board-id> <post-ids...>")
    .action((boardId, postIds, _, command) => output(command, addBoardItems(getDb(), boardId, postIds)));
  boards
    .command("note <board-id> <item-id> <note...>")
    .action((boardId, itemId, note, _, command) => output(command, updateBoardItem(getDb(), boardId, itemId, {
      note: note.join(" "),
    })));

  const backup = program.command("backup").description("Git-friendly JSONL backups");
  backup
    .command("export <path>")
    .action((path, _, command) => output(command, exportBackup(path)));
  backup
    .command("validate <path>")
    .action((path, _, command) => output(command, validateBackup(path)));
  backup
    .command("import <path>")
    .option("--restore", "Replace portable local rows exactly")
    .action((path, options, command) => output(command, importBackup(path, options)));
  backup
    .command("sync")
    .requiredOption("--repo <path>", "Local Git backup repository")
    .option("--remote <url>", "Private Git remote")
    .option("--branch <name>", "Branch name", "main")
    .option("--no-push", "Commit without pushing")
    .action((options, command) => output(command, syncBackup(options)));

  const compose = program.command("compose").description("Draft or publish Instagram content");
  compose
    .command("post [caption...]")
    .option("--media <path-or-url>", "Media file or public URL (repeatable)", collect, [])
    .option("--transport <transport>", "cookie or graph", "cookie")
    .option("--story", "Publish as a story")
    .option("--reel", "Publish as a reel")
    .option("--carousel", "Publish as a carousel")
    .option("--alt <text>", "Alt text")
    .option("--cover <url>", "Reel cover URL")
    .option("--no-share-to-feed", "Do not share reel to feed")
    .option("--yes", "Perform the live write")
    .action(async (caption, options, command) => {
      const text = caption.join(" ");
      let result;
      if (options.transport === "graph") {
        if (!options.yes) {
          result = await runWebAction(options.story ? "story" : options.reel ? "reel" : "post", null, {
            text,
            media: options.media,
            transport: "graph",
          }, { yes: false });
        } else {
          result = await graphPublish({
            type: options.story ? "story" : options.reel ? "reel" : options.carousel ? "carousel" : "post",
            caption: text,
            mediaUrls: options.media,
            altText: options.alt,
            coverUrl: options.cover,
            shareToFeed: options.shareToFeed,
          }, globals(command));
        }
      } else {
        if (options.media.length !== 1 || /^https?:/i.test(options.media[0] ?? "")) {
          throw new Error("Cookie publishing accepts exactly one local JPEG. Use Graph transport for URLs, reels, or carousels.");
        }
        result = await uploadWebPhoto({
          file: options.media[0],
          caption: text,
          story: Boolean(options.story),
        }, { ...globals(command), yes: options.yes });
      }
      output(command, result);
    });
  compose
    .command("comment <media-id> <text...>")
    .option("--reply-to <comment-id>", "Reply to a comment")
    .option("--transport <transport>", "cookie or graph", "cookie")
    .option("--yes", "Perform the live write")
    .action(async (mediaId, text, options, command) => {
      const body = text.join(" ");
      const result = options.transport === "graph" && options.yes
        ? options.replyTo
          ? await graphReplyToComment(options.replyTo, body, globals(command))
          : await graphComment(mediaId, body, globals(command))
        : await runWebAction("comment", mediaId, { text: body, replyTo: options.replyTo }, {
            ...globals(command),
            yes: options.yes,
          });
      output(command, result);
    });
  compose
    .command("dm <thread-or-user-id> <text...>")
    .option("--transport <transport>", "cookie or graph", "cookie")
    .option("--yes", "Perform the live write")
    .action(async (target, text, options, command) => {
      const body = text.join(" ");
      const result = options.transport === "graph" && options.yes
        ? await graphSendMessage(target, body, globals(command))
        : await runWebAction("dm", target, { text: body }, { ...globals(command), yes: options.yes });
      output(command, result);
    });

  for (const kind of ["like", "unlike", "save", "unsave", "follow", "unfollow", "block", "unblock"]) {
    program
      .command(`${kind} <target>`)
      .description(`${kind[0].toUpperCase()}${kind.slice(1)} a post or profile`)
      .option("--yes", "Perform the live write")
      .action(async (target, options, command) => output(
        command,
        await runWebAction(kind, target, {}, { ...globals(command), yes: options.yes }),
      ));
  }

  const actions = program.command("actions").description("Inspect local drafts and write history");
  actions
    .command("list")
    .option("--status <status>", "draft, queued, sent, or failed")
    .option("--limit <count>", "Maximum results", positiveInteger, 100)
    .action((options, command) => {
      const db = getDb();
      const rows = options.status
        ? db.prepare("select * from action_queue where status=? order by created_at desc limit ?").all(options.status, options.limit)
        : db.prepare("select * from action_queue order by created_at desc limit ?").all(options.limit);
      output(command, { items: rows });
    });

  const config = program.command("config").description("Read or update local configuration");
  config
    .command("show")
    .action((_, command) => output(command, loadConfig()));
  config
    .command("set <path> <value>")
    .description("Set a dotted config key")
    .action((path, value, _, command) => {
      output(command, updateConfig((current) => {
        const parts = path.split(".").filter(Boolean);
        if (!parts.length) throw new Error("Config path cannot be empty.");
        let cursor = current;
        for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
        cursor[parts.at(-1)] = parseConfigValue(value);
        return current;
      }));
    });

  program
    .command("serve")
    .description("Run the local web workspace")
    .option("--host <host>", "Listener host", "127.0.0.1")
    .option("--port <port>", "Listener port", positiveInteger, 4667)
    .option("--open", "Open the workspace in your browser")
    .option("--demo", "Seed demo data when the workspace is empty")
    .action(async (options, command) => {
      const result = await serve(options);
      output(command, { ok: true, url: result.url, privacy: "Local loopback by default" });
    });

  program
    .command("reindex")
    .description("Rebuild full-text search indexes")
    .action((_, command) => {
      rebuildFts(getDb());
      output(command, { ok: true });
    });

  await program.parseAsync(argv);
}

function globals(command) {
  const options = command.optsWithGlobals();
  return {
    cookieSource: options.cookieSource,
    chromeProfile: options.chromeProfile,
    firefoxProfile: options.firefoxProfile,
    cookieFile: options.cookieFile,
    sessionId: options.sessionId,
    csrfToken: options.csrfToken,
    userId: options.userId,
    timeout: options.timeout,
  };
}

function output(command, value) {
  printValue(value, Boolean(command.optsWithGlobals().json));
}

function collect(value, previous) {
  return [...previous, value];
}

function positiveInteger(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return number;
}

function parseConfigValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./mcp";

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the open documents the running server reports", async () => {
    const documents = [
      {
        path: documentPath,
        sessionLabel: "plan-review",
        openedAt: "2026-11-26T00:00:00.000Z",
        lastSavedAt: null,
      },
    ];
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ documents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await callTool(
      "roughdraft_get_open_documents",
      {},
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(urls).toEqual(["http://localhost:7373/api/status"]);
    expect(result).toEqual({ running: true, documents });
  });

  it("returns the done-signal of the round from the review watch", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [{ sequence: 1, done: true, doneReason: "threads-cleared" }],
          timedOut: false,
          nextSequence: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({ done: true, doneReason: "threads-cleared" });
  });

  it("bounds each review watch poll and forwards a caller's shorter timeout", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ events: [], timedOut: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      batchWindowSeconds: 0.25,
      fromNow: true,
    });
    // Omitting timeoutSeconds still waits indefinitely, in bounded polls.
    expect(requestBodies[0]?.timeoutSeconds).toBeGreaterThan(0);
    expect(requestBodies[0]?.timeoutSeconds).toBeLessThanOrEqual(240);
    expect(requestBodies[1]).toMatchObject({
      timeoutSeconds: 5,
    });
  });

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });

  it("accepts, rejects and edits a suggestion into plain prose", async () => {
    fs.writeFileSync(
      documentPath,
      [
        '# Draft\n\nKeep {++clear wording++}{id="s1" by="AI" at="2026-04-23T18:00:00.000Z"} here.',
        'Use {~~old~>new~~}{id="s2" by="AI" at="2026-04-23T18:01:00.000Z"} now.',
        "",
      ].join("\n"),
    );
    const env = { ROUGHDRAFT_STATE_FILE: stateFile };

    await callTool(
      "roughdraft_decide_suggestion",
      { documentPath, targetId: "s1", action: "accept" },
      env,
    );
    await callTool(
      "roughdraft_decide_suggestion",
      { documentPath, targetId: "s2", action: "edit", text: "newer" },
      env,
    );

    expect(fs.readFileSync(documentPath, "utf8")).toBe(
      "# Draft\n\nKeep clear wording here.\nUse newer now.\n",
    );
    await expect(
      callTool(
        "roughdraft_decide_suggestion",
        { documentPath, targetId: "s1", action: "maybe" },
        env,
      ),
    ).rejects.toThrow(/action must be/);
  });
  it("asks for comment events only when includeComments is set", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          events: [
            {
              type: "comment.added",
              sequence: 3,
              comments: [{ id: "c2", kind: "comment", text: "Cut this" }],
            },
          ],
          timedOut: false,
          nextSequence: 4,
          instanceId: "i1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const env = { ROUGHDRAFT_STATE_FILE: stateFile };

    const plain = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, timeoutSeconds: 1 },
      env,
      fetchImpl,
    );
    const withComments = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, timeoutSeconds: 1, includeComments: true },
      env,
      fetchImpl,
    );

    expect(bodies[0]).not.toHaveProperty("includeComments");
    expect(bodies[0]?.batchWindowSeconds).toBe(0.25);
    expect(bodies[1]).toMatchObject({
      includeComments: true,
      batchWindowSeconds: 3,
    });
    // A comment event is not a done-signal.
    expect(withComments).toMatchObject({ done: false, doneReason: null });
    expect(plain).toMatchObject({ done: false });
  });

  it("returns the new reply id from roughdraft_reply_to_comment", async () => {
    fs.writeFileSync(
      documentPath,
      '# Draft\n\nKeep {==it==}{>>Why?<<}{#c1} here.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-11-28T10:00:00.000Z"\n',
    );

    const result = (await callTool(
      "roughdraft_reply_to_comment",
      { documentPath, parentId: "c1", message: "Because." },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { ok: boolean; id: string; parentId: string };

    expect(result).toMatchObject({ ok: true, parentId: "c1" });
    expect(result.id).not.toBe("");
    expect(fs.readFileSync(documentPath, "utf8")).toContain("Because.");
  });

  it("sends afterSequence as a literal cursor instead of from now", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ events: [], timedOut: true, nextSequence: 9 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await callTool(
      "roughdraft_watch_review_events",
      {
        documentPath,
        timeoutSeconds: 0,
        includeComments: true,
        afterSequence: 4,
      },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(bodies[0]).toMatchObject({ fromNow: false, afterSequence: 4 });
  });

  describe("tab windows", () => {
    interface Call {
      method: string;
      path: string;
      body: unknown;
    }

    function recordingFetch(answers: Record<string, unknown>) {
      const calls: Call[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify(answers[url.pathname] ?? {}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      return { calls, fetchImpl };
    }

    const env = () => ({ ROUGHDRAFT_STATE_FILE: stateFile });

    it("opens several files as tabs and asks the server to open the window", async () => {
      const second = path.join(projectDir, "second.md");
      fs.writeFileSync(second, "# Second\n");
      const answer = {
        results: [
          { path: documentPath, status: "open-window", windowId: "w1" },
          { path: second, status: "queued", releaseAt: "2026-11-28T12:00:00Z" },
        ],
        url: "/tabs?window=w1",
        windowId: "w1",
        opened: true,
      };
      const { calls, fetchImpl } = recordingFetch({
        "/api/tabs/open": answer,
      });

      const result = await callTool(
        "roughdraft_open_tabs",
        { paths: [documentPath, second], now: true, label: "plan", since: "HEAD~1" },
        env(),
        fetchImpl,
      );

      expect(result).toEqual(answer);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tabs/open" });
      expect(calls[0]?.body).toMatchObject({
        tabs: [
          { path: documentPath, label: "plan", since: "HEAD~1" },
          { path: second, label: "plan", since: "HEAD~1" },
        ],
        now: true,
        open: true,
      });
    });

    it("lists the tabs and the queue, and says so when Roughdraft is not running", async () => {
      const listing = {
        windows: [{ id: "w1", tabs: [] }],
        queue: { items: [], releaseAt: null, batchOpenedAt: null },
      };
      const { calls, fetchImpl } = recordingFetch({ "/api/tabs": listing });

      expect(await callTool("roughdraft_list_tabs", {}, env(), fetchImpl)).toEqual(
        { running: true, ...listing },
      );
      expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tabs" });

      fs.rmSync(stateFile);
      expect(
        await callTool("roughdraft_list_tabs", {}, env(), fetchImpl),
      ).toMatchObject({ running: false, windows: [] });
    });

    it("adds one tab at once", async () => {
      const { calls, fetchImpl } = recordingFetch({
        "/api/tabs/open": { results: [{ path: documentPath, status: "added" }] },
      });

      await callTool(
        "roughdraft_add_tab",
        { path: documentPath, windowId: "w1" },
        env(),
        fetchImpl,
      );

      expect(calls[0]?.body).toMatchObject({
        tabs: [{ path: documentPath }],
        now: true,
        open: true,
        windowId: "w1",
      });
    });

    it("focuses and closes a tab", async () => {
      const { calls, fetchImpl } = recordingFetch({
        "/api/tabs/focus": { focused: true },
        "/api/tabs/close": { closed: true, from: "window" },
      });

      expect(
        await callTool("roughdraft_focus_tab", { path: documentPath }, env(), fetchImpl),
      ).toEqual({ focused: true });
      expect(
        await callTool(
          "roughdraft_close_tab",
          { path: documentPath, windowId: "w2" },
          env(),
          fetchImpl,
        ),
      ).toEqual({ closed: true, from: "window" });
      expect(calls.map((call) => call.path)).toEqual([
        "/api/tabs/focus",
        "/api/tabs/close",
      ]);
      expect(calls[1]?.body).toEqual({ path: documentPath, windowId: "w2" });
    });

    it("releases the queue and lets the server open the window", async () => {
      const { calls, fetchImpl } = recordingFetch({
        "/api/tabs/release": { released: 2, windowId: "w1" },
      });

      expect(
        await callTool("roughdraft_release_queued_tabs", {}, env(), fetchImpl),
      ).toEqual({ released: 2, windowId: "w1" });
      expect(calls[0]).toMatchObject({
        path: "/api/tabs/release",
        body: { open: true },
      });
    });

    it("watches several files at once and reports each", async () => {
      const second = path.join(projectDir, "second.md");
      fs.writeFileSync(second, "# Second\n");
      const bodies: Array<{ path: string }> = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { path: string };
        bodies.push(body);
        const done = body.path === "draft.md";
        return new Response(
          JSON.stringify(
            done
              ? {
                  events: [{ sequence: 1, doneReason: "threads-cleared" }],
                  timedOut: false,
                  nextSequence: 2,
                }
              : { events: [], timedOut: true, nextSequence: 1 },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = (await callTool(
        "roughdraft_watch_review_events",
        { paths: [documentPath, second], timeoutSeconds: 0 },
        env(),
        fetchImpl,
      )) as {
        allDone: boolean;
        documents: Array<{ documentPath: string; done: boolean; timedOut: boolean }>;
      };

      expect(bodies.map((body) => body.path).sort()).toEqual([
        "draft.md",
        "second.md",
      ]);
      expect(result.allDone).toBe(false);
      expect(result.documents).toMatchObject([
        { documentPath, done: true, timedOut: false },
        { documentPath: second, done: false, timedOut: true },
      ]);
    });

    it("passes since to add_tab", async () => {
      const { calls, fetchImpl } = recordingFetch({
        "/api/tabs/open": { results: [{ path: documentPath, status: "added" }] },
      });

      await callTool(
        "roughdraft_add_tab",
        { path: documentPath, since: "main" },
        env(),
        fetchImpl,
      );

      expect(calls[0]?.body).toMatchObject({
        tabs: [{ path: documentPath, since: "main" }],
      });
    });

    describe("roughdraft_get_changes", () => {
      function baselineFetch(status: number, payload: unknown) {
        const urls: URL[] = [];
        const fetchImpl: typeof fetch = async (input) => {
          urls.push(new URL(String(input)));
          return new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        };
        return { urls, fetchImpl };
      }

      it("diffs the file on disk against the baseline the server returns", async () => {
        fs.writeFileSync(documentPath, "# Draft\n\nNew paragraph.\n");
        const { urls, fetchImpl } = baselineFetch(200, {
          source: "git",
          label: "git HEAD",
          content: "# Draft\n",
        });

        const result = (await callTool(
          "roughdraft_get_changes",
          { path: documentPath, since: "HEAD" },
          env(),
          fetchImpl,
        )) as {
          source: string;
          label: string;
          changes: Array<{ kind: string; newText: string }>;
          summary: { added: number };
        };

        expect(urls[0]?.pathname).toBe("/api/document-baseline");
        expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toEqual({
          projectPath: projectDir,
          path: "draft.md",
          since: "HEAD",
        });
        expect(result.source).toBe("git");
        expect(result.label).toBe("git HEAD");
        expect(result.summary.added).toBe(1);
        expect(result.changes).toMatchObject([
          { kind: "added", newText: "New paragraph." },
        ]);
      });

      it("asks for last-review by default and fails with the server's reason when there is no baseline", async () => {
        const { urls, fetchImpl } = baselineFetch(404, {
          error: "No baseline for nope",
        });

        await expect(
          callTool(
            "roughdraft_get_changes",
            { path: documentPath },
            env(),
            fetchImpl,
          ),
        ).rejects.toThrow("No baseline for nope");
        expect(urls[0]?.searchParams.get("since")).toBe("last-review");
      });
    });

    it("rejects open_tabs without paths", async () => {
      await expect(
        callTool("roughdraft_open_tabs", {}, env(), recordingFetch({}).fetchImpl),
      ).rejects.toThrow("paths is required");
    });
  });
});

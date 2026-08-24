import { describe, expect, it } from 'vitest';
import { parseDiffFiles } from '../src/git/git-browser.js';

describe('diff parser', () => {
  it('groups files and hunks with stable safe anchors', () => {
    const files = parseDiffFiles(`diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1,2 @@
-old
+new
+<script>alert(1)</script>`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      status: 'renamed',
      additions: 2,
      deletions: 1,
    });
    expect(files[0]?.anchor).toMatch(/^diff-[A-Za-z0-9_-]+$/);
    expect(files[0]?.hunks[0]?.lines).toContain('+<script>alert(1)</script>');
  });

  it('recognizes added, deleted, and binary files', () => {
    const files = parseDiffFiles(`diff --git a/added b/added
new file mode 100644
@@ -0,0 +1 @@
+hello
diff --git a/deleted b/deleted
deleted file mode 100644
@@ -1 +0,0 @@
-bye
diff --git a/picture.png b/picture.png
Binary files a/picture.png and b/picture.png differ`);

    expect(files.map(({ status }) => status)).toEqual(['added', 'deleted', 'binary']);
    expect(files[2]?.binary).toBe(true);
  });

  it('enforces file-count and individual-file byte ceilings', () => {
    const diff = `diff --git a/one b/one
@@ -1 +1 @@
-${'a'.repeat(100)}
+${'b'.repeat(100)}
diff --git a/two b/two
@@ -1 +1 @@
-old
+new`;
    const files = parseDiffFiles(diff, 1, 80);
    expect(files).toHaveLength(1);
    expect(files[0]?.truncated).toBe(true);
  });
});

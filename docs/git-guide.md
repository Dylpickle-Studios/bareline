# Git guide

This guide assumes no prior server-hosting experience. Git stores snapshots called commits. A
branch is a movable name for a commit; a tag is normally a stable name for a release. Your local
repository and the hosted repository exchange commits and names without requiring a shared working
directory.

## Creating a repository

Choose **New repository**, select your user or a group you manage, choose public or private
visibility, and optionally create a README. A public repository can be browsed anonymously when the
administrator enables that policy. A private repository is visible only to its owner and granted
users or groups.

## Cloning and remotes

Cloning creates a local copy and names the server `origin`:

```sh
git clone https://git.example.com/alice/project.git
cd project
git remote -v
```

To connect an existing local repository, run `git remote add origin URL`. A remote is simply a
saved name and URL. Use the clone dialog to avoid typing the URL incorrectly.

## Committing and history

Edit files, stage the intended changes, then commit the snapshot:

```sh
git status
git add README.md
git commit -m "Explain installation"
```

`git status` should be checked before every commit. The web history shows authorship, exact dates,
parents, signatures, and diffs. A cryptographically valid signature proves possession of a key; it
does not by itself prove the real-world identity of the signer.

## Pushing and pulling

`git push -u origin main` publishes the local `main` branch and remembers its upstream. Later,
`git push` is enough. `git pull` fetches remote work and integrates it into the current branch.
Prefer `git fetch` followed by inspection when you do not want automatic integration.

For HTTPS, use your username and a personal access token instead of your account password. Tokens
are shown once. Give Git clients only repository scopes. For SSH, add the public key—not the private
key—to account settings.

## Branches

Create an isolated line of work with `git switch -c topic`, publish it with `git push -u origin
topic`, and switch back with `git switch main`. Deleting a server branch does not delete commits
still reachable from another ref. The default branch cannot be deleted.

## Tags

Create an annotated release tag with `git tag -a v1.1.0 -m "Version 1.1.0"`, then publish it with
`git push origin v1.1.0`. Signed annotated tags expose verification state in the tag list. Do not
move release tags after publishing them.

## SSH keys

Generate a modern key with `ssh-keygen -t ed25519`. Save the private key only on your device. Copy
the `.pub` file into Git credentials. The server's forced command accepts only upload-pack and
receive-pack for repositories you may access and never creates an interactive shell.

## Git LFS

Install Git LFS, run `git lfs install`, then select patterns such as `git lfs track '*.psd'` and
commit `.gitattributes`. Git commits contain small pointer files while payloads use the local LFS
store. LFS data must be included in backups.

## Comparisons, blame, and archives

Compare two refs from the Compare page using `base...head`. Blame attributes each displayed line to
the last changing commit; it is historical evidence, not a judgment of responsibility. Branches,
tags, and commits can be downloaded as ZIP or tar.gz archives subject to server limits.

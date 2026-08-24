# OpenSSH Setup

Bareline relies on the system OpenSSH server and never exposes an application shell.

1. Create a dedicated locked Unix account such as `git` with no usable password.
2. Build the application and ensure the `bareline` bundle and configuration are readable by that
   account.
3. Generate authorized-key entries:

   ```bash
   bareline ssh authorized-keys --executable /opt/bareline/bin/bareline \
     --config /etc/bareline/config.yml > authorized_keys.new
   install -m 0600 -o git -g git authorized_keys.new /var/lib/bareline/.ssh/authorized_keys
   ```

4. Configure `sshd` to disallow password login, forwarding, and interactive shells for the account.

Generated entries use OpenSSH's `restrict` option and a per-key forced command. The handler accepts
only `git-upload-pack 'owner/repository.git'` and `git-receive-pack 'owner/repository.git'`, resolves
the logical name through SQLite, checks the key owner's permission, and invokes Git without a shell.

Repository deploy keys are emitted by the same commands. Their forced command accepts only
`git-upload-pack` and verifies that the requested repository is exactly the one assigned to the
key. Deploy keys can never open a shell, push, or read another repository. Regenerate the dedicated
account's `authorized_keys` after changing user or deploy keys.

Signed-commit and message-prefix branch policies conservatively disable SSH pushes because Bareline
does not install executable repository hooks. Force-push and deletion controls are enforced through
Git's receive configuration.

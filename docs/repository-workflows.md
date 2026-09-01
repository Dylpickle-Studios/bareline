# Repository workflows

Bareline provides repository-centred collaboration without a pull-request system. Unless stated
otherwise, repository visibility and read permission determine whether a person can view a workflow;
write permission is required for operations that change Git data or repository content.

## Issues

Each repository has numbered issues with Markdown descriptions, comments, open/closed state, labels,
and one assignee. Signed-in readers can open issues and comment. Authors can edit their own issues or
comments and close or reopen their own issues; labeling and assignment require write access. See
[Administration](administration.md#issue-tracker) for the complete permission model and webhook
events. The issue tracker is also available through the documented REST API.

## Patches and branch operations

The **Patches** page lets writers paste or upload a patch, select a target branch, and review a
dry-run preview before importing it. A single commit and a comparison range can be exported as
`git format-patch` output. Importing a patch creates Git commits directly in the bare repository;
it does not create a working tree.

Signed-in users can fork repositories they can read. Writers can cherry-pick or revert a non-merge
commit onto a selected branch, or merge one branch into another. The merge form fast-forwards where
possible and otherwise creates a three-way merge commit. These operations obey the repository's
normal write and branch-policy controls; a conflict or policy failure leaves the target unchanged.

## Wikis

Open **Wiki** from a repository to browse Markdown pages, edit a page, view its history, or delete
a page. Each wiki is stored in a separate small Git repository owned by the parent repository, so
its visibility follows the parent and page history is retained. Editing and deletion require write
access to the parent repository.

## Releases

Open **Releases** to publish a tag-backed release with Markdown notes and optional binary assets.
Readers can download release assets when they can read the repository. Creating or deleting a
release and uploading an asset require repository write access. A release records an existing tag;
it is not a replacement for signing and verifying the Git tag or the application release artifacts.

## Insights and stars

The **Insights** page reports a per-language byte breakdown and per-author commit counts for the
selected ref, together with the repository's fork count. Signed-in users can star or unstar a
repository. These are lightweight repository signals, not project tracking or ranking controls.

## Automation boundary

The supported programmatic interface is the versioned REST API and its OpenAPI document at
`/api/docs`. The issue tracker has REST endpoints. The workflows described above are currently
server-rendered UI flows and do not imply corresponding REST endpoints. See [REST API](api.md) for
the API contract and authentication requirements.

## LLM-oriented discovery

`/llms.txt` is a plain-text, link-dense summary of the public product endpoints for LLM-based tools.
It is an orientation document, not an API contract; integrations must use the OpenAPI document and
normal repository authorization.

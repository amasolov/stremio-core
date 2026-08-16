# Board catalog rows never show pages beyond the first (paginating addons capped at one page)

## Summary

`serialize_catalogs_with_extra` emits only the **first page** of each board
catalog and truncates it to **10 items**. For addons that paginate (any addon
declaring the `skip` extra), a home-screen row can never grow past the first
page, even after `CatalogsWithExtra::LoadNextPage` has successfully fetched and
stored further pages — those pages are dropped at serialization time.

This differs from `serialize_discover`, which flattens *all* loaded pages for
the same underlying data and applies no per-item cap.

## Where

`stremio-core-web/src/model/serialize_catalogs_with_extra.rs`
(observed on `stremio-core-web-v0.59.0`, unchanged on `development`):

```rust
.filter_map(|catalog| catalog.first())   // only page 0 reaches JS
...
    meta_items
        .iter()
        .unique_by(|meta_item| &meta_item.id)
        .take(10)
```

Compare `serialize_discover.rs`, which flattens every loaded page:

```rust
discover
    .catalog
    .iter()
    .filter_map(|page| page.content.as_ref())
    .filter_map(|page_content| page_content.ready())
    .flat_map(|meta_items| meta_items.iter().map(...))
```

## Why this looks like a bug

`CatalogsWithExtra` already implements `ActionCatalogsWithExtra::LoadNextPage(index)`,
which correctly computes `skip + items.len()`, issues the request, and pushes
the new page into the model. I confirmed the addon *is* queried for page two
(the stub addon below logs `skip=0` then `skip=20`), but the extra page never
reaches JS because `.first()` discards it.

So today `LoadNextPage` for `CatalogsWithExtra` does real network work whose
result is guaranteed to be thrown away.

## Reproduce

1. Install an addon whose catalog declares `"extra": [{"name": "skip"}]` and
   has more items than one page.
2. Open the board. The row renders one page.
3. Dispatch `CatalogsWithExtra::LoadNextPage` for that row. The addon receives
   the `skip=` request and responds, but the row does not change.

## Verification of the proposed change

Patched `serialize_catalogs_with_extra` to flatten across loaded pages and drop
the `take(10)`, keeping page one as the identity/deep-link anchor and leaving
`unique_by` in place to dedupe across page boundaries.

Built both a stock `v0.59.0` and a patched `stremio_core_web_bg.wasm`, then
served two otherwise byte-identical stremio-web `v5.0.0-beta.38` builds that
differ *only* in that binary, driving them in headless Chromium against a stub
addon serving 20 items/page:

| build   | initial row | after `LoadNextPage` |
|---------|-------------|----------------------|
| stock   | 10          | 10                   |
| patched | 20          | 40                   |

Stable across three runs; items render in order (`Item 000` … `Item 039`) with
no duplicates.

Note both runs above also raise stremio-web's `CATALOG_PREVIEW_SIZE`
(`src/common/CONSTANTS.js`), which is **10**. Without that, the web layer caps
the row at 10 regardless of what the serializer emits, so a complete fix spans
both repos.

## Question before I open a PR

Is the 10-item board row an intentional preview limit, with "See all" as the
path to the full list? If so, `LoadNextPage` on `CatalogsWithExtra` is dead code
and could be documented or removed.

If it isn't intentional, I have the patch and the harness above ready to submit.
Happy to go either way — I'd rather ask than send an unsolicited behavior change
to the home screen.

## Environment

- `stremio-core-web` 0.59.0 (also present on `development`)
- stremio-web v5.0.0-beta.38, self-hosted

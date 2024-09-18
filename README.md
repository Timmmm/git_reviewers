# Reviewers.ts

This is a simple script to look up `git blame` for a commit in order to figure out who you should ask for a review.

To use:

1. Install Deno.
2. Download `reviewers.ts`, make it executable, add it to `PATH`.
3. In your repo run `reviewers.ts [branch]`. By default `branch` is `master` and can be omitted. If you are using `main` you have to run `reviewers.ts main`.

It will print a list of names and the number of their lines you have touched, for example:

    $ reviewers.ts
    John Jones: 120
    Marc Henlsy: 97
    Christoph Meed: 90
    Tim Hutt: 47
    David Hunt: 32
    Alex Cordo: 28
    Tom Lamb: 14
    Lewis Pardo: 11
    Gerard N: 6
    Annie Axe: 4
    Alexis Shade: 2

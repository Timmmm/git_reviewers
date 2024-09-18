#!/usr/bin/env -S deno run --allow-all

async function run(cmd: string[]): Promise<string> {
    // Optional logging.
    // console.log(`%c❯ ${cmd.join(" ")}`, "color: green");

    const process = Deno.run({ cmd, stdout: 'piped' });

    // We can't await the status first because that won't
    // close the output pipe so it never exits.
    const [status, output] = await Promise.all([
        process.status(),
        process.output(),
    ]);

    if (!status.success) {
        throw new Error("Process failed");
    }
    return await new TextDecoder().decode(output);
}

interface FileDiff {
    // Original filename. Null means no file.
    from: string | null;
    // New filename. Null means no file.
    to: string | null;

    // Line numbers in the original file that were removed. These are 1-based.
    linesRemoved: number[];
    // Line numbers in the new file (after modifications) that were added.
    // Modification is removal and then addition.
    linesAdded: number[];
}

function newFileDiff(): FileDiff {
    return {
        from: null,
        to: null,
        linesRemoved: [],
        linesAdded: [],
    };
}

// Parse a git unified diff to find the line numbers that were removed from
// a and added to b.
function parseDiff(diff: string): FileDiff[] {
    const diffs: FileDiff[] = [];
    let current = newFileDiff();

    let currentLineFrom = 0;
    let currentLineTo = 0;

    for (const line of diff.split("\n")) {
        if (line === "") {
            // There's an empty line at the end.
            continue;
        }
        switch (line[0]) {
            case "d":
                // diff; add new one.
                current = newFileDiff();
                diffs.push(current);
                break;
            case "i":
                // index; skip.
                break;
            case "n":
                // new file mode; skip.
                break;
            case "-": {
                // ---
                if (line === "--- /dev/null") {
                    current.from = null;
                } else {
                    const matches = line.match(/^--- a\/(.*)$/);
                    if (matches === null) {
                        throw new Error(`Diff parse error: ${line}`);
                    }
                    current.from = matches[1];
                }
                break;
            }
            case "+": {
                // +++
                if (line === "+++ /dev/null") {
                    current.from = null;
                } else {
                    const matches = line.match(/^\+\+\+ b\/(.*)$/);
                    if (matches === null) {
                        throw new Error(`Diff parse error: ${line}`);
                    }
                    current.to = matches[1];
                }
                break;
            }

            case "@": {
                // @@ -<from_start>[,<from_len>] +<to_start>[,<to_len>] @@
                const matches = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/);
                if (matches === null) {
                    throw new Error(`Diff parse error: ${line}`);
                }
                currentLineFrom = parseInt(matches[1], 10);
                currentLineTo = parseInt(matches[2], 10);
                break;
            }
            case "N":
                // New (added)
                current.linesAdded.push(currentLineTo);
                ++currentLineTo;
                break;
            case "O":
                // Old (removed)
                current.linesRemoved.push(currentLineFrom);
                ++currentLineFrom;
                break;
            case " ":
                // Unchanged
                ++currentLineFrom;
                ++currentLineTo;
                break;
        }
    }

    return diffs;
}

// For each line starting wuth `author ...` increment the author in the map.
function parseBlame(blame: string, counts: Map<string, number>) {
    for (const line of blame.split("\n")) {
        if (line.startsWith("author ")) {
            const author = line.substring(7);

            counts.set(author, (counts.get(author) ?? 0) + 1);
        }
    }
}

function printResults(counts: Map<string, number>) {
    const sorted = [...counts];

    sorted.sort((a, b) => b[1] - a[1]);

    for (const person of sorted) {
        console.log(`${person[0]}: ${person[1]}`);
    }
}

// Get the number of lines in a file the same way git blame does. It does not
// consider a trailing \n to be a line.
async function countLines(filename: string): Promise<number> {
    const contents = await Deno.readFile(filename);

    const LF = 10;
    let lines = contents[contents.length - 1] === LF ? 0 : 1;
    for (let pos = contents.indexOf(LF); pos !== -1; pos = contents.indexOf(LF, pos + 1)) {
        ++lines;
    }
    return lines;
}

// Get the right-open contiguous ranges of a sorted set of numbers.
function contiguousRanges(vals: number[]): [number, number][] {
    const ranges: [number, number][] = [];
    let currentRange: [number, number] | null = null;

    for (const v of vals) {
        if (currentRange !== null && v === currentRange[1]) {
            ++currentRange[1];
        } else {
            if (currentRange !== null) {
                ranges.push(currentRange);
            }
            currentRange = [v, v+1];
        }
    }
    if (currentRange !== null) {
        ranges.push(currentRange);
    }
    return ranges;
}

async function isFile(file: string): Promise<boolean> {
    const s = await Deno.stat(file);
    return s.isFile;
}

async function main() {
    // Commit/branch to compare to (actually we compare to the merge-base).
    const master = Deno.args[0] || "master";

    const topLevel = (await run(["git", "--no-pager", "rev-parse", "--show-toplevel"])).trim();

    // Get the diff in unified format.
    const diff = await run(["git", "--no-pager", "diff", "--output-indicator-new=N", "--output-indicator-old=O", "--merge-base", master, "HEAD"]);

    // Get blame for each line that was removed from the original one,
    // and also lines adjacent to ones we have added.

    const fileDiffs = parseDiff(diff);

    const counts = new Map<string, number>();

    // Get blame of the removed lines.
    for (const fileDiff of fileDiffs) {
        if (fileDiff.from === null) {
            continue;
        }

        const absFrom = `${topLevel}/${fileDiff.from}`;

        // Only look at normal files (directories can appear with submodules).
        if (!await isFile(absFrom)) {
            continue;
        }

        if (fileDiff.linesRemoved.length === 0) {
            continue;
        }

        const command = ["git", "--no-pager", "blame", "--line-porcelain", "-w"];
        for (const [start,end] of contiguousRanges(fileDiff.linesRemoved)) {
            command.push("-L");
            command.push(`${start},+${end-start}`);
        }
        command.push(master);
        command.push("--");
        command.push(absFrom);

        const blame = await run(command);

        parseBlame(blame, counts);
    }

    // Get the blame around the added lines. To do this we need to know
    // the number of lines in the `to` file.
    for (const fileDiff of fileDiffs) {
        if (fileDiff.to === null) {
            continue;
        }

        const absTo = `${topLevel}/${fileDiff.to}`;

        // Only look at normal files (directories can appear with submodules).
        if (!await isFile(absTo)) {
            continue;
        }

        const numLines = await countLines(absTo);

        const allLines = new Set<number>();
        // Add all the lines around the changed lines.
        for (const line of fileDiff.linesAdded) {
            for (let i = -2; i <= 2; ++i) {
                const x = line + i;
                if (x >= 1 && x <= numLines) {
                    allLines.add(x);
                }
            }
        }
        // Remove the lines that we added/modified.
        for (const line of fileDiff.linesAdded) {
            allLines.delete(line);
        }

        if (allLines.size === 0) {
            continue;
        }

        const command = ["git", "--no-pager", "blame", "--line-porcelain", "-w"];
        for (const [start, end] of contiguousRanges([...allLines].toSorted((a, b) => a - b))) {
            command.push("-L");
            command.push(`${start},+${end-start}`);
        }
        command.push("--");
        command.push(absTo);

        const blame = await run(command);

        parseBlame(blame, counts);
    }

    printResults(counts);
}

await main();

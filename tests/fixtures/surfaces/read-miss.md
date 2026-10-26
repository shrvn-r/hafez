Two renders of what `hafez read` prints for a slug that does not exist. Each fenced block is one complete output, on stderr, with the not-found exit code. Under `--json` the miss is `{"slug": "<slug>", "closest": ["<slug>", …]}` on stdout, with the same exit code. The create line is the Block's entity create line with the miss's slug words as the name; a miss is a guessed entity slug far more often than a knowledge one.

## Close slugs

```
Error: no entity or knowledge note 'meeting-transcriber'.
hafez read meeting-transcript-pipeline
hafez read farsi-meeting-transcription-script
hafez create entity "meeting transcriber" --type <project|entity> --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"
```

## No close slug

```
Error: no entity or knowledge note 'launchpads'.
hafez search "launchpads"
hafez create entity "launchpads" --type <project|entity> --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"
```

# Notes API

A small JSON API that stores short text notes.

## Who uses it

A developer who builds a notes app and needs a backend for it.

## What they can do

- `POST /notes` with `{ "text": "..." }` creates a note and returns it with an `id` and a `createdAt` time. Text is required and at most 500 characters. Invalid input returns 400 with an error message.
- `GET /notes` returns all notes, newest first.
- `DELETE /notes/:id` deletes a note and returns 204. An unknown id returns 404.

## Constraints

- Store notes in memory. No database, no login.
- Include automated tests for every endpoint, including the error cases.

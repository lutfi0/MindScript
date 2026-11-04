# MindScript Privacy Policy

Last updated: November 4, 2026

MindScript is a voice dictation app for Windows, published by Lzero Labs.
It is built to work entirely on your own computer.

## What MindScript processes

- **Your voice.** When you start a dictation, MindScript records audio from
  your microphone and turns it into text on your computer. The audio is kept
  in memory only for that dictation and is never saved to disk or sent
  anywhere.
- **Your text.** The transcript, and the cleaned-up version if you turn on
  text cleanup, is processed on your computer and pasted into the app you are
  typing in.
- **History, settings and logs.** Past dictations, your settings and a
  diagnostic log of app events (`diag.log`) are stored on your computer in
  `%APPDATA%\mindscript\`. They never leave it. You can delete single entries
  in the History page, or remove the folder to delete everything.

## What MindScript does not do

- It does not collect, sell or share personal information.
- It has no user accounts, analytics, telemetry, advertising or crash
  reporting.
- It never sends your audio or your text to us or to any third party.

## When MindScript connects to the internet

MindScript only connects to the internet to download files you choose:

- speech and text-cleanup models from Hugging Face (`huggingface.co`), or
  from the `hf-mirror.com` mirror if Hugging Face can't be reached,
- the whisper.cpp and llama.cpp GPU engines from their official GitHub
  releases, or from the MindScript GitHub releases for the AMD/Intel build,
- any model you add yourself from a download link, from the address you gave.

The version installed outside the Microsoft Store also checks GitHub Releases
for app updates. The Microsoft Store version is updated by the Store.

These downloads are ordinary web requests. The servers receive your IP
address and basic request details, as with any download, and handle them
under their own privacy policies. No audio, text or personal information is
included.

If you choose the optional Ollama cleanup engine, text is sent to the Ollama
server address you set in the settings. By default that is a server on your
own computer.

## Children

MindScript does not knowingly collect any information from anyone, including
children.

## Changes

If this policy changes, the new version will be published at this address
with a new date.

## Contact

Questions about this policy: hi@lutfisevim.dev

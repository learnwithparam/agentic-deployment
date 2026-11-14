# When is Cloud Run the better choice?

Cloud Run is better when many people ship the desk and you want the platform to keep every revision and hold
the key. Compose with my own scripts is better when one machine is enough.

What the emulator does not do: it cannot mount a secret as a file, so the key goes in as a value here. It
also stores a traffic setting without applying it, so I roll back by patching the old template, which makes a
new revision.

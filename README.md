## Why

this is the umpteenth time a PM or similar has asked me to see if the code uses "this random list of words" and I'm tired of doing it manually.

## What

This is a simple script that will search a directory for files with then search those files for a list of words. It will then append the results into a json file with the file paths and occurrences of the words from the list.


## How

1. Clone the repo
2. `cd` into the repo
3. Add words to the `search_fields.txt` file (one word per line)
4. `node ./search_script.js <path to directory>`

## todo

- [ ] add a way to specify the output file name
- [ ] add a way to specify the search words file name

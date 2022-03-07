# deletediscordmessages
Fork of dead https://github.com/victornpb/deleteDiscordMessages repository with fixes

## What?
You can mass delete Discord messages with this. Use the tampermonkey extension for your browser and install this script.

## Usage
Click the trash can on your preferred channel and then click start. If you want to only delete before a certain message, you need the message's ID. You can copy the message ID from a discord message by enabling developer mode and right clicking.

### Changes Include
- Adjust delete speed to overall be more consistent with deleting
- Adjust backoff delays
- Added offset code to handle 'system' messages including calls and notices properly
- Fixed bug where attempting to resume deleting a previously started channel would error
- Added automatic value grabbing of user values for faster user experience upon window open (you can still manually get any channel)
- And more that I forgot since this was a couple years ago

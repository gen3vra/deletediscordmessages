# deletediscordmessages
Fork of dead https://github.com/victornpb/deleteDiscordMessages repository with fixes

### Changes Include
- Adjust delete speed to overall be more consistent with deleting
- Adjust backoff delays
- Added offset code to handle 'system' messages including calls and notices properly
- Fixed bug where attempting to resume deleting a previously started channel would error
- Added automatic value grabbing of user values for faster user experience upon window open (you can still manually get any channel)
- And more that I forgot since this was a couple years ago

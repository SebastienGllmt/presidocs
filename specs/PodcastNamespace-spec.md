# Podcasting 2.0 Namespace — tags used by this engine

Authoritative source: https://podcastindex.org/namespace/1.0 (per-tag docs at
github.com/Podcastindex-org/podcast-namespace/tree/main/docs/tags). Mirrored here
are the tags this engine emits: <podcast:guid>, <podcast:chapters>,
<podcast:transcript>, <podcast:person>.

---

# Guid

`<podcast:guid>`

This element is used to declare a unique, global identifier for a podcast. The value is a UUIDv5, and is easily generated from the RSS feed url, with the **protocol scheme and trailing slashes stripped off**, combined with a unique "podcast" namespace which has a UUID of `ead4c236-bf58-58c6-a2c6-a6b28d128cb6`. Tools like [this one](https://www.uuidtools.com/v5) can help generate these values by hand. Or, language libraries like [this one](https://github.com/sporkmonger/uuidtools) in Ruby are widely available. Specifically for podcasts, [this tool from RSS Blue](https://tools.rssblue.com/podcast-guid) can help generate a GUID by hand.

A podcast gets assigned a podcast:guid once in its lifetime using its current feed url (at the time of assignment) as the seed value. That GUID is then meant to follow the podcast from then on, for the duration of its life, even if the feed url changes. This means that when a podcast moves from one hosting platform to another, its podcast:guid should be discovered by the new host and imported into the new platform for inclusion into the feed.

Using this pattern, podcasts can maintain a consistent identity across the open RSS ecosystem without a central authority.

**Tips:**

- All podcasts in the Podcast Index have already been assigned a GUID; but if one exists in the RSS feed, that value is canonical.
- You can programmatically spot a GUID: it is 36 characters long, and contains four hyphen characters.
- Be aware that Amazon Music also uses separate UUIDv5 identifiers within their podcast directory, which are calculated differently and unrelated to this specification.
- The following regular expression (regex) will match a GUID:

```re
[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`
```

### Parent

`<channel>`

### Count

Single

### Node Value

The node value is a UUIDv5 string.

### Examples

Example GUID for feed url `mp3s.nashownotes.com/pc20rss.xml`:

```xml
<podcast:guid>917393e3-1b1e-5cef-ace4-edaa54e1f810</podcast:guid>
```

Example GUID for feed url `podnews.net/rss`:

```xml
<podcast:guid>9b024349-ccf0-5f69-a609-6b82873eab3c</podcast:guid>
```

### Guid-enabled fast-follow share links

The `podcast:guid` value above enables podcasters to produce a link that can share a podcast on a variety of different platforms.

The format of the link is `https://(a podcast website link)#fastfollow-(type):(a podcast guid)`

`type` is currently `podcast`, but may be extended in future.

A working example is https://podnews.net/podcast/i8xe9/listen#fastfollow-podcast:9b024349-ccf0-5f69-a609-6b82873eab3c or the QR code given below.

![podnews-qr](https://user-images.githubusercontent.com/231941/127796108-d819de43-6c0e-4c7b-9579-ed1f19989443.png)

When scanned on a mobile phone's camera app, this link will go to the specified podcast website. Behavior of this website is up to the creator: some may use a default homepage, others may sniff the useragent and open a default podcast app on a device. In the working example, above, an iPhone user may be taken to Apple Podcasts; an Android user may be taken to Google Podcasts; and another device will be given a page with a player.

When scanned on a QR code reader inside a podcast app, like [CurioCaster](https://curiocaster.com/), the app can parse the `<podcast:guid>` value from the URL, allowing the podcast to be opened within the application.

---

# Chapters

`<podcast:chapters>`

Links to an external file (see example file) containing chapter data for the episode. See the [jsonChapters.md](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/chapters/jsonChapters.md) file for a description of the file syntax for chapters syntax. And, see the [example.json](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/chapters/example.json) example file for a real world example.

Benefits with this approach are that chapters do not require altering audio files, and the chapters can be edited after publishing, since they are a separate file that can be requested on playback (or cached with download). JSON chapter information also allows chapters to be displayed by a wider range of playback tools, including web browsers (which typically have no access to ID3 tags), thus greatly simplifying chapter support; and images can be retrieved on playback, rather than bloating the filesize of the audio. The data held is compatible with normal ID3 tags, thus requiring no additional work for the publisher.

### Parent

`<item>`

### Count

Single

### Attributes

- `url` **(required)**: The URL where the chapters file is located.
- `type` **(required)**: Mime type of file - JSON prefered, 'application/json+chapters'.

### Examples

```xml
<podcast:chapters url="https://example.com/episode1/chapters.json" type="application/json+chapters" />
```

---

# Transcript

`<podcast:transcript>`

This tag is used to link to a transcript or closed captions file. Multiple tags can be present for multiple transcript formats.

Detailed file format information and example files are [here](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/transcripts/transcripts.md).

### Parent

`<item>`

### Count

Multiple

### Attributes

- `url` **(required)**: URL of the podcast transcript.
- `type` **(required)**: Mime type of the file such as `text/plain`, `text/html`, `text/vtt`, `application/json`, `application/x-subrip`
- `language` (optional): The language of the linked transcript. If there is no language attribute given, the linked file is assumed to be the same language that is specified by the RSS `<language>` element.
- `rel` (optional): If the `rel="captions"` attribute is present, the linked file is considered to be a closed captions file, regardless of what the mime type is. In that scenario, time codes are assumed to be present in the file in some capacity.

### Examples

```xml
<podcast:transcript url="https://example.com/episode1/transcript.html" type="text/html" />
```

```xml
<podcast:transcript url="https://example.com/episode1/transcript.vtt" type="text/vtt" />
```

```xml
<podcast:transcript
        url="https://example.com/episode1/transcript.json"
        type="application/json"
        language="es"
        rel="captions"
/>
```

```xml
<podcast:transcript url="https://example.com/episode1/transcript.srt" type="application/x-subrip" rel="captions" />
```

---

# Person

`<podcast:person>`

This element specifies a person of interest to the podcast. It is primarily intended to identify people like hosts, co-hosts and guests. Although, it is flexible enough to allow fuller credits to be given using the roles and groups that are listed in the [Podcast Taxonomy Project](https://podcasttaxonomy.com/)

### Parent

`<channel>` (for a podcast) or `<item>` (for an individual episode)

It is suggested that `<channel>` is always populated, and `<item>` is populated where needed for an individual episode. Where present, people information in `<item>` wholly replaces all information from the `<channel>`.

Publishers are expected to use the `<podcast:person>` element in the `<channel>` parent to set the _regular_ people involved in the podcast: the detail that would be expected to be seen in an overview of the show.

Publishers are expected to use the `<podcast:person>` in the `<item>` parent to **replace** all existing information for an individual episode.

#### For example: _Terry and June_

The fictional podcast _Terry and June_ is normally hosted by Terry Scott and June Whitfield. Within `<channel>`, Terry Scott and June Whitfield are listed as the hosts. A podcast directory, or podcast app, should show Terry Scott and June Whitfield as the hosts of this show.

For one episode, _Terry and June_ was hosted by Reginald Marsh and June Whitfield (Terry was away). In this case, the `<item>` for this episode should contain Reginald Marsh and June Whitfield as the hosts of this episode. A podcast app, when playing this episode, should show only Reginald Marsh and June Whitfield as the hosts of this episode. Because people information in `<item>` replaces all existing people information in `<channel>`, Terry Scott should not be visible as a host of this episode.

#### For example: _Big Daddy_

The fictional podcast _Big Daddy Interviews_ is hosted by Big Daddy, a wrestler. Within `<channel>`, Big Daddy is listed as the host. A podcast directory, or podcast app, should show Big Daddy as the host of this show.

For one episode, _Big Daddy Interviews_ had a guest of Sid James. In this case, the `<item>` for this episode should contain Sid James as a guest, **and** Big Daddy as the host of this episode. Because people information in `<item>` replaces all existing people information in `<channel>`, Big Daddy should be re-stated as the host of this episode.

### Count

Multiple

### Node value

This is the full name or alias of the person. This value cannot be blank. Please do not exceed `128 characters` for the node value or it may be truncated by aggregators.

### Attributes

- `role` (optional): Used to identify what role the person serves on the show or episode. This should be a reference to an official role within the Podcast Taxonomy Project list (see below). If `role` is missing then "host" is assumed.
- `group` (optional): This should be a reference to an official group within the Podcast Taxonomy Project list. If `group` is not present, then "cast" is assumed.
- `img` (optional): This is the url of a picture or avatar of the person.
- `href` (optional): The url to a relevant resource of information about the person, such as a homepage or third-party profile platform. Please see the [example feed](https://github.com/Podcastindex-org/podcast-namespace/blob/main/example.xml) for possible choices of what to use here.

The `role` and `group` attributes are case-insensitive. So, "Host" is the same as "host", and "Cover Art Designer" is the same as "cover art designer".

The full taxonomy list is [here](https://github.com/Podcastindex-org/podcast-namespace/blob/main/taxonomy.json) as a json file.

### Examples

```xml
<podcast:person
        href="https://example.com/johnsmith/blog"
        img="https://example.com/images/johnsmith.jpg"
>John Smith</podcast:person>
```

```xml
<podcast:person
        role="guest"
        href="https://www.imdb.com/name/nm0427852888/"
        img="https://example.com/images/janedoe.jpg"
>Jane Doe</podcast:person>
```

```xml
<podcast:person
        role="guest"
        href="https://example.wikipedia/alicebrown"
        img="https://example.com/images/alicebrown.jpg"
>Alice Brown</podcast:person>
```

```xml
<podcast:person
        group="writing"
        role="guest"
        href="https://example.wikipedia/alicebrown"
        img="https://example.com/images/alicebrown.jpg"
>Alice Brown</podcast:person>
```

```xml
<podcast:person
        group="visuals"
        role="Cover Art Designer"
        href="https://example.com/artist/beckysmith"
>Becky Smith</podcast:person>
```


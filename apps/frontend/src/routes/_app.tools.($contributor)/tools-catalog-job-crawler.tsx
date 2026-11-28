import { useState } from "react";
import { tv } from "tailwind-variants";

import CopyCommand from "@/components/copy-command";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { catalogService } from "@/services/catalog/catalog-service";
import {
  JOB_CRAWLER_DAYS,
  JOB_CRAWLER_DEFAULT_OUTPUT_DIR,
  JOB_CRAWLER_INITIAL_CHOICES,
  JOB_CRAWLER_LOCATIONS,
  JOB_CRAWLER_ROLES,
  JOB_CRAWLER_SITES,
  jobCrawlerCommand,
  toggledChoice,
  type JobCrawlerOption,
} from "@/utils/utils.job-crawler-command";
import useSiteOrigin from "@/utils/utils.site-origin";

const jobCrawler = tv({
  slots: {
    container: "space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4",
    group: "space-y-2",
    caption:
      "font-mono text-[10px] font-semibold tracking-wider text-zinc-500 uppercase",
    help: "text-[11px] text-zinc-500",
  },
});

const tag = tv({
  base: "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    selected: {
      true: "border-zinc-900 bg-zinc-900 text-white",
      false: "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-500",
    },
  },
});

interface TagGroupProps {
  label: string;
  hint: string;
  options: readonly JobCrawlerOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}

/** A titled row of tags to switch on and off. A tag that is on is `aria-pressed`. */
function TagGroup({ label, hint, options, selected, onToggle }: TagGroupProps) {
  const { group, caption, help } = jobCrawler();

  return (
    <div className={group()}>
      <Flex className="flex-wrap items-baseline justify-between gap-x-3">
        <p className={caption()}>{label}</p>

        <p className={help()}>{hint}</p>
      </Flex>

      <Flex className="flex-wrap gap-1.5">
        {options.map((option) => {
          const picked = selected.includes(option.value);

          return (
            <button
              type="button"
              key={option.value}
              aria-pressed={picked}
              onClick={() => onToggle(option.value)}
              className={tag({ selected: picked })}
            >
              {option.label}
            </button>
          );
        })}
      </Flex>
    </div>
  );
}

/**
 * Builds the command that runs the job crawler. Tags pick the places, the roles
 * and the sources; a row picks how far back; a box names the folder. Nothing is
 * picked at first, and picking nothing in a row means all of it, as the tool
 * itself does, so the command only names what was picked.
 */
export default function ToolsCatalogJobCrawler() {
  const { container, group, caption, help } = jobCrawler();
  const siteOrigin = useSiteOrigin();
  const [choices, setChoices] = useState(JOB_CRAWLER_INITIAL_CHOICES);

  return (
    <div className={container()}>
      <TagGroup
        label="Location"
        hint="anywhere unless you pick some"
        options={JOB_CRAWLER_LOCATIONS}
        selected={choices.locations}
        onToggle={(value) =>
          setChoices({
            ...choices,
            locations: toggledChoice(
              JOB_CRAWLER_LOCATIONS,
              choices.locations,
              value,
            ),
          })
        }
      />

      <TagGroup
        label="Role"
        hint="any role unless you pick some"
        options={JOB_CRAWLER_ROLES}
        selected={choices.roles}
        onToggle={(value) =>
          setChoices({
            ...choices,
            roles: toggledChoice(JOB_CRAWLER_ROLES, choices.roles, value),
          })
        }
      />

      <TagGroup
        label="Source"
        hint="every site unless you pick some"
        options={JOB_CRAWLER_SITES}
        selected={choices.sources}
        onToggle={(value) =>
          setChoices({
            ...choices,
            sources: toggledChoice(JOB_CRAWLER_SITES, choices.sources, value),
          })
        }
      />

      <TagGroup
        label="Posted in the last"
        hint="the last 30 days unless you pick another"
        options={JOB_CRAWLER_DAYS}
        selected={choices.days === null ? [] : [String(choices.days)]}
        onToggle={(value) =>
          setChoices({
            ...choices,
            days: choices.days === Number(value) ? null : Number(value),
          })
        }
      />

      <div className={group()}>
        <Flex className="flex-wrap items-baseline justify-between gap-x-3">
          <p className={caption()}>Save the spreadsheet in</p>

          <p className={help()}>
            {JOB_CRAWLER_DEFAULT_OUTPUT_DIR} unless you type another
          </p>
        </Flex>

        <Input
          aria-label="Folder for the spreadsheet"
          value={choices.outputDir}
          placeholder={JOB_CRAWLER_DEFAULT_OUTPUT_DIR}
          onChange={(event) =>
            setChoices({ ...choices, outputDir: event.target.value })
          }
          className="h-9 bg-white font-mono text-xs"
        />
      </div>

      <div className={group()}>
        <p className={caption()}>Command</p>

        <CopyCommand
          command={jobCrawlerCommand(
            catalogService.jobCrawlerScriptUrl(siteOrigin),
            choices,
          )}
        />

        <p className={help()}>
          Copy it and run it in a terminal. Needs Python 3.9 or newer. On a Mac
          with Chrome it reads the pages in your own Chrome, with your logins:
          tick View, Developer, Allow JavaScript from Apple Events in Chrome
          once, or the command stops and says so. Elsewhere it uses a browser it
          installs, which Cloudflare often blocks.
        </p>
      </div>
    </div>
  );
}

create index if not exists analysis_source_files_superseded_by_idx
on public.analysis_source_files (superseded_by)
where superseded_by is not null;
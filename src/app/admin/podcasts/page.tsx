import {CatalogueList} from "@/components/catalogue-list";
export default async function Page({searchParams}:PageProps<"/admin/podcasts">) {return <CatalogueList kind="podcasts" params={await searchParams}/>;}
